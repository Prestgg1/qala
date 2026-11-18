/**
 * A small app for the shutdown and request-limit tests (test/lifecycle.test.ts). It runs under Bun and, built with
 * scriptc, as a native binary; limits come from the environment so one build serves every test.
 */
import { controller, createApp, get, post, serve, sse, ws } from "@qala/core";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : Number(raw);
}

function wait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const LabController = controller({}, () => ({
  fast: get("/fast", {}, () => ({ ok: true })),
  slow: get("/slow", {}, async ({ ctx }) => {
    await wait(Number(ctx.query["ms"] ?? "500"));
    return { done: true };
  }),
  size: post("/size", {}, ({ ctx }) => ({ bytes: ctx.request.raw.length })),
  events: get("/events", {}, ({ ctx }) =>
    sse(ctx, (events) => {
      events.comment("connected");
      const timer = setInterval(() => events.comment("ping"), 100);
      events.onClose(() => {
        clearInterval(timer);
        console.log("sse closed");
      });
    }),
  ),
  echo: ws("/ws", {
    message: (socket, data) => socket.send(data),
    close: (_socket, code) => console.log(`ws closed ${code}`),
  }),
}));

const app = createApp({ controllers: [{ name: "lab", prefix: "", controller: LabController }] });
app.onShutdown(async () => {
  await wait(10);
  console.log("hook ran");
});

serve(app, {
  port: num("PORT", 3000),
  host: "127.0.0.1",
  bodyLimit: num("BODY_LIMIT", 1024),
  headersTimeout: num("HEADERS_TIMEOUT", 1000),
  requestTimeout: num("REQUEST_TIMEOUT", 1000),
  keepAliveTimeout: num("KEEP_ALIVE_TIMEOUT", 500),
  wsMaxMessage: num("WS_MAX_MESSAGE", 1024),
  shutdownTimeout: num("SHUTDOWN_TIMEOUT", 3000),
  workers: num("WORKERS", 1),
}).then(() => console.log("ready"));
