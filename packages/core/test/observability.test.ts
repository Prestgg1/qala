/** Request ids, structured request/error logs and the built-in /health and /ready probes. */
import { describe, expect, spyOn, test } from "bun:test";
import { controller, createApp, Database, get, Logger, provide, requestLogger, validRequestId } from "@qala/core";
import { RequestData } from "../src/http/context";

const Notes = controller({}, () => ({
  index: get("/", {}, ({ ctx }) => {
    ctx.log.info("listing notes", { count: 0 });
    return { id: ctx.requestId };
  }),
  crash: get("/crash", {}, () => {
    throw new Error("boom");
  }),
}));

function request(path: string, headers: Record<string, string> = {}, method = "GET"): RequestData {
  return new RequestData(method, path, headers, "", "127.0.0.1");
}

/** Captures console.log/console.error lines while `fn` runs. */
async function capture(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const out = spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
  const err = spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)));
  try {
    await fn();
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  return lines;
}


describe("request ids", () => {
  test("validRequestId", () => {
    expect(validRequestId("abc-123_X.y:z")).toBe(true);
    expect(validRequestId("a".repeat(128))).toBe(true);
    expect(validRequestId("a".repeat(129))).toBe(false);
    expect(validRequestId("")).toBe(false);
    expect(validRequestId("has space")).toBe(false);
    expect(validRequestId("line\nbreak")).toBe(false);
    expect(validRequestId('quote"')).toBe(false);
  });

  test("a valid incoming id is reused, exposed on ctx and echoed", async () => {
    const app = createApp({ controllers: [{ name: "notes", prefix: "/notes", controller: Notes }], logger: new Logger("error") });
    const reply = await app.handle(request("/notes", { "x-request-id": "req-42" }));
    expect(reply.headers["x-request-id"]).toBe("req-42");
    expect(reply.body).toBe(JSON.stringify({ id: "req-42" }));
  });

  test("a missing or invalid id is replaced by a generated one", async () => {
    const app = createApp({ controllers: [{ name: "notes", prefix: "/notes", controller: Notes }], logger: new Logger("error") });
    const a = (await app.handle(request("/notes"))).headers["x-request-id"]!;
    const b = (await app.handle(request("/notes", { "x-request-id": "bad id\u0000" }))).headers["x-request-id"]!;
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  test("404s and errors carry the id too; requestId: false turns it off", async () => {
    const app = createApp({ controllers: [], logger: new Logger("error") });
    expect((await app.handle(request("/nope", { "x-request-id": "r1" }))).headers["x-request-id"]).toBe("r1");
    const off = createApp({ controllers: [], requestId: false, logger: new Logger("error") });
    expect((await off.handle(request("/nope", { "x-request-id": "r1" }))).headers["x-request-id"]).toBeUndefined();
  });
});

describe("structured logs", () => {
  test("requestLogger and ctx.log write one JSON object per line with request_id", async () => {
    const logger = new Logger("info", "json");
    const app = createApp({ controllers: [{ name: "notes", prefix: "/notes", controller: Notes }], logger, middleware: [requestLogger(logger)] });
    const lines = await capture(async () => {
      await app.handle(request("/notes", { "x-request-id": "rid-1" }));
    });
    expect(lines.length).toBe(2);
    const [handler, access] = lines.map((l) => JSON.parse(l));
    expect(handler).toMatchObject({ level: "info", message: "listing notes", request_id: "rid-1", count: 0 });
    expect(access).toMatchObject({ level: "info", message: "GET /notes", request_id: "rid-1", method: "GET", path: "/notes", status: 200 });
    expect(typeof access.duration_ms).toBe("number");
    expect(typeof access.time).toBe("string");
  });

  test("the 500 log line has request_id, method, path, status and duration_ms", async () => {
    const logger = new Logger("info", "json");
    const app = createApp({ controllers: [{ name: "notes", prefix: "/notes", controller: Notes }], logger });
    const lines = await capture(async () => {
      expect((await app.handle(request("/notes/crash", { "x-request-id": "rid-2" }))).status).toBe(500);
    });
    expect(lines.length).toBe(1);
    expect(lines[0]!.includes("\n")).toBe(false);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "error", message: "Unhandled error: boom", request_id: "rid-2", method: "GET", path: "/notes/crash", status: 500 });
  });

  test("child loggers merge fields", async () => {
    const lines = await capture(async () => {
      new Logger("info", "json").child({ a: 1 }).child({ b: 2 }).info("hi", { c: 3 });
    });
    expect(JSON.parse(lines[0]!)).toMatchObject({ message: "hi", a: 1, b: 2, c: 3 });
  });
});

describe("/health and /ready", () => {
  test("answer 200 by default, before global middleware", async () => {
    let ran = 0;
    const app = createApp({ controllers: [], logger: new Logger("error"), middleware: [async (_ctx, next) => (ran++, next())] });
    const health = await app.handle(request("/health"));
    expect([health.status, health.body]).toEqual([200, JSON.stringify({ status: "ok" })]);
    expect(health.headers["x-request-id"]).toMatch(/^[0-9a-f]{32}$/);
    const ready = await app.handle(request("/ready"));
    expect([ready.status, ready.body]).toEqual([200, JSON.stringify({ status: "ready" })]);
    expect(ran).toBe(0);
    expect((await app.handle(request("/health", {}, "POST"))).status).toBe(404);
  });

  test("/ready is 503 once shutdown started; /health stays 200", async () => {
    const app = createApp({ controllers: [], logger: new Logger("error") });
    await app.shutdown(100);
    expect((await app.handle(request("/ready"))).status).toBe(503);
    expect((await app.handle(request("/health"))).status).toBe(200);
  });

  test("/ready is 503 when the database does not answer", async () => {
    const db = new Database("postgres://nobody:x@127.0.0.1:1/none");
    const app = createApp({ controllers: [], logger: new Logger("error"), providers: [provide(Database, () => db)], readyTimeout: 300 });
    const ready = await app.handle(request("/ready"));
    expect(ready.status).toBe(503);
    expect(JSON.parse(String(ready.body))).toEqual({ status: "unavailable", checks: { database: "down" } });
    db.close();
  });

  test("an app route on /health wins; health: false turns the probes off", async () => {
    const Mine = controller({}, () => ({ index: get("/", {}, () => ({ mine: true })) }));
    const app = createApp({ controllers: [{ name: "health", prefix: "/health", controller: Mine }], logger: new Logger("error") });
    expect((await app.handle(request("/health"))).body).toBe(JSON.stringify({ mine: true }));
    const off = createApp({ controllers: [], health: false, logger: new Logger("error") });
    expect((await off.handle(request("/health"))).status).toBe(404);
    expect((await off.handle(request("/ready"))).status).toBe(404);
  });
});

const DB_URL = process.env["QALA_TEST_DATABASE_URL"];

describe.if(DB_URL !== undefined)("/ready with a database", () => {
  test("200 with database up", async () => {
    const db = new Database(DB_URL!);
    const app = createApp({ controllers: [], logger: new Logger("error"), providers: [provide(Database, () => db)] });
    const ready = await app.handle(request("/ready"));
    expect([ready.status, JSON.parse(String(ready.body))]).toEqual([200, { status: "ready", checks: { database: "up" } }]);
    db.close();
  });
});
