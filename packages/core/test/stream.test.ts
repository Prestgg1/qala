import { describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { controller, type ControllerEntry, createApp, get, type Middleware, serve, sse, stream, ws } from "@qala/core";

let disconnects = 0;

const tag: Middleware = async (ctx, next) => {
  ctx.setHeader("x-tag", "on");
  ctx.setCookie("seen", "1");
  return next();
};

const LiveController = controller({}, () => ({
  events: get("/events", {}, ({ ctx }) =>
    sse(ctx, (events) => {
      events.comment("connected");
      events.send({ id: 1, event: "hello", data: "first" });
      events.send({ id: 2, data: "line one\nline two" });
      events.send({ data: "{\"n\":3}" });
      events.close();
    }),
  ),
  forever: get("/forever", {}, ({ ctx }) =>
    sse(ctx, (events) => {
      events.comment("connected");
      const timer = setInterval(() => events.comment("ping"), 20);
      events.onClose(() => {
        clearInterval(timer);
        disconnects++;
      });
    }),
  ),
  text: get("/text", {}, ({ ctx }) =>
    stream(ctx, (out) => {
      let n = 0;
      const timer = setInterval(() => {
        out.write(`chunk ${++n}\n`);
        if (n === 3) {
          clearInterval(timer);
          out.close();
        }
      }, 5);
    }),
  ),
}), { middleware: [tag] });

const EchoController = controller({}, () => ({ echo: ws("/echo", { message: (s, d) => s.send(d) }) }));

async function readAll(res: Response): Promise<string> {
  return await res.text();
}

function suite(name: string, port: number, withSockets: boolean): void {
  describe(`streaming (${name})`, () => {
    test("start", async () => {
      const controllers: ControllerEntry[] = [{ name: "live", prefix: "/live", controller: LiveController }];
      if (withSockets) controllers.push({ name: "echo", prefix: "/sock", controller: EchoController });
      await serve(createApp({ controllers }), { port, host: "127.0.0.1", handleSignals: false });
    });

    test("SSE frames, headers and cookies from middleware", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/live/events`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
      expect(res.headers.get("x-tag")).toBe("on");
      expect(res.headers.get("set-cookie")).toContain("seen=1");
      expect(await readAll(res)).toBe(": connected\n\nid: 1\nevent: hello\ndata: first\n\nid: 2\ndata: line one\ndata: line two\n\ndata: {\"n\":3}\n\n");
    });

    test("plain text stream", async () => {
      expect(await readAll(await fetch(`http://127.0.0.1:${port}/live/text`))).toBe("chunk 1\nchunk 2\nchunk 3\n");
    });

    test("client disconnect runs onClose", async () => {
      const before = disconnects;
      const received: string[] = [];
      const socket = connect(port, "127.0.0.1");
      socket.on("data", (d: Buffer) => received.push(d.toString("utf8")));
      socket.write(`GET /live/forever HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n`);
      for (let i = 0; i < 100 && !received.join("").includes(": connected"); i++) await Bun.sleep(10);
      expect(received.join("")).toContain(": connected");
      socket.destroy();
      for (let i = 0; i < 100 && disconnects === before; i++) await Bun.sleep(20);
      expect(disconnects).toBe(before + 1);
    });
  });
}

suite("http routes only", 39561, false);
suite("with WebSocket routes", 39562, true);
