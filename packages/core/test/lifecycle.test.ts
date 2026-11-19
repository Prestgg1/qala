/**
 * Graceful shutdown and request limits. The unit tests drive `Lifecycle` and `App.shutdown` in-process; the process
 * tests start test/fixtures/lifecycle-app.ts under Bun and, with QALA_NATIVE=1, as a scriptc native binary (the
 * node:http path, which is what production runs), then send signals and misbehaving clients at it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, controller, createApp, get, Lifecycle, provide, StreamSink, StreamWriter, WsSender, WsSocket } from "@qala/core";
import { Context, RequestData } from "../src/http/context";

const ROOT = join(import.meta.dir, "../../..");
const FIXTURE = join(import.meta.dir, "fixtures/lifecycle-app.ts");

function fakeSocket(closes: number[]): WsSocket {
  const ctx = new Context(new RequestData("GET", "/", {}, "", ""), "/", new Container([]));
  return new WsSocket(new WsSender(() => {}, (code) => closes.push(code), () => {}), ctx);
}

describe("Lifecycle", () => {
  test("idle resolves at once when nothing is open", async () => {
    expect(await new Lifecycle().idle(1000)).toBe(true);
  });

  test("idle waits for the last request", async () => {
    const life = new Lifecycle();
    life.begin();
    life.begin();
    const done = life.idle(1000);
    life.end();
    setTimeout(() => life.end(), 20);
    expect(await done).toBe(true);
    expect(life.inflight).toBe(0);
  });

  test("idle gives up after the timeout", async () => {
    const life = new Lifecycle();
    life.begin();
    const started = Date.now();
    expect(await life.idle(50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("stop closes WebSockets with 1001, ends streams and runs the server's stop", async () => {
    const life = new Lifecycle();
    const closes: number[] = [];
    const id = life.addSocket(fakeSocket(closes));
    let ended = 0;
    const sink = new StreamSink(new StreamWriter(() => {}, () => ended++));
    life.addStream(sink);
    let stopped = 0;
    life.onStop(() => stopped++);
    life.stop();
    expect(life.draining).toBe(true);
    expect(closes).toEqual([1001]);
    expect(ended).toBe(1);
    expect(sink.closed).toBe(true);
    expect(stopped).toBe(1);
    expect(life.openStreams).toBe(0);
    // The socket stays tracked until its transport reports the close.
    expect(await life.idle(20)).toBe(false);
    life.removeSocket(id);
    expect(await life.idle(20)).toBe(true);
  });
});

class Resource {
  closed = false;
}

describe("App.shutdown", () => {
  test("waits for in-flight work, runs hooks last-registered first, once", async () => {
    const app = createApp({ controllers: [], logger: undefined });
    const order: string[] = [];
    app.onShutdown(() => {
      order.push("first");
    });
    app.onShutdown(async () => {
      await Bun.sleep(5);
      order.push("second");
    });
    app.lifecycle.begin();
    setTimeout(() => {
      order.push("request done");
      app.lifecycle.end();
    }, 30);
    const [a, b] = await Promise.all([app.shutdown(1000), app.shutdown(1000)]);
    expect([a, b]).toEqual([true, true]);
    expect(app.shuttingDown).toBe(true);
    expect(order).toEqual(["request done", "second", "first"]);
  });

  test("a failing hook does not stop the others; timeout reports false", async () => {
    const app = createApp({ controllers: [] });
    const ran: string[] = [];
    app.onShutdown(() => {
      ran.push("ok");
    });
    app.onShutdown(() => {
      throw new Error("boom");
    });
    app.lifecycle.begin();
    expect(await app.shutdown(30)).toBe(false);
    expect(ran).toEqual(["ok"]);
  });

  test("Container.peek returns only singletons already created", () => {
    const c = new Container([provide(Resource, () => new Resource())]);
    expect(c.peek(Resource)).toBeNull();
    const r = c.get(Resource);
    expect(c.peek(Resource)).toBe(r);
  });

  test("an app with a route still answers while draining", async () => {
    const Hello = controller({}, () => ({ hi: get("/hi", {}, () => ({ hi: 1 })) }));
    const app = createApp({ controllers: [{ name: "hello", prefix: "", controller: Hello }] });
    const shutdown = app.shutdown(100);
    const reply = await app.handle(new RequestData("GET", "/hi", {}, "", ""));
    expect(reply.status).toBe(200);
    await shutdown;
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Process tests

type Running = { proc: ChildProcess; port: number; output: () => string; exited: Promise<number> };

let nativeBinary = "";
let nativeDir = "";
const NATIVE = process.env["QALA_NATIVE"] === "1";

beforeAll(() => {
  if (!NATIVE) return;
  nativeDir = mkdtempSync(join(tmpdir(), "qala-lifecycle-"));
  nativeBinary = join(nativeDir, "app");
  const scriptc = join(ROOT, "node_modules/.bin/scriptc");
  const built = spawnSync(scriptc, ["build", FIXTURE, "--node-islands=off", "-o", nativeBinary], { cwd: ROOT, encoding: "utf8" });
  if (built.status !== 0) throw new Error(`scriptc failed:\n${built.stdout}\n${built.stderr}`);
}, 300_000);

afterAll(() => {
  if (nativeDir !== "") rmSync(nativeDir, { recursive: true, force: true });
});

let nextPort = 41000 + Math.floor(Math.random() * 2000);

async function start(target: string, env: Record<string, string> = {}): Promise<Running> {
  const port = nextPort++;
  const childEnv = { ...process.env, PORT: String(port), ...env };
  const proc = target === "native" ? spawn(nativeBinary, [], { env: childEnv }) : spawn("bun", [FIXTURE], { env: childEnv, cwd: ROOT });
  let out = "";
  proc.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  proc.stderr!.on("data", (d: Buffer) => (out += d.toString()));
  const exited = new Promise<number>((resolve) => proc.on("exit", (code) => resolve(code ?? -1)));
  for (let i = 0; i < 200 && !out.includes("ready"); i++) await Bun.sleep(25);
  if (!out.includes("ready")) throw new Error(`fixture did not start:\n${out}`);
  return { proc, port, output: () => out, exited };
}

/** Opens a raw TCP connection; resolves what the server sent and how long until it closed the connection. */
function raw(port: number, send: string, waitMs: number): Promise<{ data: string; ms: number; closed: boolean }> {
  return new Promise((resolve) => {
    const started = Date.now();
    let data = "";
    let done = false;
    const socket: Socket = connect(port, "127.0.0.1", () => socket.write(send));
    const finish = (closed: boolean): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ data, ms: Date.now() - started, closed });
    };
    socket.on("data", (d) => (data += d.toString()));
    socket.on("close", () => finish(true));
    socket.on("error", () => finish(true));
    setTimeout(() => finish(false), waitMs);
  });
}

function wsClose(port: number, onOpen: (socket: WebSocket) => void = () => {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.onopen = () => onOpen(socket);
    socket.onerror = () => reject(new Error("ws error"));
    socket.onclose = (e) => resolve(e.code);
  });
}

function suite(target: string): void {
  describe(`limits and shutdown (${target})`, () => {
    let app: Running;
    beforeAll(async () => {
      app = await start(target);
    });
    afterAll(() => {
      app.proc.kill("SIGKILL");
    });

    test("bodies over bodyLimit get 413", async () => {
      const ok = await fetch(`http://127.0.0.1:${app.port}/size`, { method: "POST", body: "x".repeat(1000) });
      expect(await ok.json()).toEqual({ bytes: 1000 });
      const big = await fetch(`http://127.0.0.1:${app.port}/size`, { method: "POST", body: "x".repeat(5000) });
      expect(big.status).toBe(413);
    });

    // Bun.serve applies its idle timer only once the request head is complete, so this is native/Node only.
    test.skipIf(target === "bun")("an incomplete request head gets 408 after headersTimeout (slowloris)", async () => {
      const r = await raw(app.port, "GET /fast HTTP/1.1\r\nHost: x\r\n", 6000);
      expect(r.closed).toBe(true);
      expect(r.ms).toBeLessThan(2500);
      expect(r.data).toStartWith("HTTP/1.1 408");
    }, 10_000);

    // Bun's idle timer has a granularity of a few seconds; the native binary answers 408 on time.
    const slack = target === "bun" ? 6000 : 2500;

    test("a body that stops arriving is cut off after requestTimeout", async () => {
      const r = await raw(app.port, "POST /size HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nonly-a-bit", 8000);
      expect(r.closed).toBe(true);
      expect(r.ms).toBeLessThan(slack);
      if (target === "native") expect(r.data).toStartWith("HTTP/1.1 408");
    }, 10_000);

    test("an idle keep-alive connection closes", async () => {
      const r = await raw(app.port, "GET /fast HTTP/1.1\r\nHost: x\r\n\r\n", 8000);
      expect(r.data).toStartWith("HTTP/1.1 200");
      expect(r.closed).toBe(true);
      expect(r.ms).toBeLessThan(slack);
    }, 10_000);

    test("a WebSocket message over wsMaxMessage closes with 1009", async () => {
      expect(await wsClose(app.port, (s) => s.send("x".repeat(2000)))).toBe(1009);
    });

    test("an open WebSocket is not cut by the header deadline", async () => {
      const echoed = await new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
        socket.onerror = () => reject(new Error("ws error"));
        socket.onopen = () => setTimeout(() => socket.send("still here"), 1500);
        socket.onmessage = (e) => {
          resolve(String(e.data));
          socket.close();
        };
      });
      expect(echoed).toBe("still here");
    });
  });

  describe(`graceful shutdown (${target})`, () => {
    test("SIGTERM finishes in-flight requests, closes WebSockets (1001) and streams, runs hooks, exits 0", async () => {
      const app = await start(target);
      const base = `http://127.0.0.1:${app.port}`;
      const wsCode = wsClose(app.port);
      const events = await fetch(`${base}/events`);
      const eventsBody = events.text();
      const slow = fetch(`${base}/slow?ms=800`);
      await Bun.sleep(150);
      app.proc.kill("SIGTERM");
      const res = await slow;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ done: true });
      expect(res.headers.get("connection")).toBe("close");
      expect(await wsCode).toBe(1001);
      expect(await eventsBody).toStartWith(": connected");
      expect(await app.exited).toBe(0);
      const out = app.output();
      expect(out).toContain("Shutting down");
      expect(out).toContain("ws closed 1001");
      expect(out).toContain("sse closed");
      expect(out).toContain("hook ran");
      expect(out).toContain("Shutdown complete");
      expect(out.indexOf("hook ran")).toBeGreaterThan(out.indexOf("Shutting down"));
      await expect(fetch(`${base}/fast`)).rejects.toThrow();
    }, 15_000);

    test("with workers, the primary stops every process gracefully before exiting", async () => {
      const app = await start(target, { WORKERS: "3" });
      for (let i = 0; i < 100 && (app.output().match(/ready/g) ?? []).length < 3; i++) await Bun.sleep(25);
      const base = `http://127.0.0.1:${app.port}`;
      // Several slow requests, so the kernel spreads them over the processes.
      const slow = [0, 1, 2, 3, 4, 5].map(() => fetch(`${base}/slow?ms=600`, { headers: { connection: "close" } }));
      await Bun.sleep(150);
      app.proc.kill("SIGTERM");
      for (const res of await Promise.all(slow)) expect(res.status).toBe(200);
      expect(await app.exited).toBe(0);
      expect((app.output().match(/Shutdown complete/g) ?? []).length).toBe(3);
    }, 15_000);

    test("a request that outlives shutdownTimeout makes the process exit 1", async () => {
      const app = await start(target, { SHUTDOWN_TIMEOUT: "300" });
      const slow = fetch(`http://127.0.0.1:${app.port}/slow?ms=5000`).catch(() => null);
      await Bun.sleep(100);
      const started = Date.now();
      app.proc.kill("SIGTERM");
      expect(await app.exited).toBe(1);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(app.output()).toContain("Shutdown timeout");
      await slow;
    }, 15_000);
  });
}

suite("bun");
if (NATIVE) suite("native");
