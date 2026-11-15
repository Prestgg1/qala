import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { App } from "./app";
import { RequestData } from "./context";
import { json, type Reply } from "./reply";
import { isWorker, resolveWorkers, startWorkers, watchParent } from "./cluster";
import { bunStreamBody, CloseSignal, StreamReply, writeNodeStream } from "./stream";
import { BunSocketState, bunWebSocketHandlers, nodeUpgrade, type BunSocket } from "./websocket";

/**
 * The part of `Bun.serve` that Qala uses. Under Bun the server always runs on Bun.serve: Bun's node:http ignores
 * `reusePort`, does not deliver upgraded sockets and does not report a client that disconnects from a streamed
 * response once the request body was read. The node:http path below serves Node and scriptc native binaries.
 */
type BunServer = { requestIP(req: Request): { address: string } | null; upgrade(req: Request, options: { data: unknown }): boolean };
type BunLike = {
  serve(options: {
    port: number;
    hostname: string;
    reusePort: boolean;
    maxRequestBodySize: number;
    idleTimeout: number;
    fetch(req: Request, server: BunServer): Promise<Response | undefined>;
    websocket: {
      open(ws: BunSocket): void;
      message(ws: BunSocket, message: string | Uint8Array): void;
      close(ws: BunSocket, code: number, reason: string): void;
    };
  }): unknown;
};
declare const Bun: BunLike | undefined;

export type ServeOptions = {
  port?: number;
  host?: string;
  /** Largest accepted request body in bytes (default 1 MiB). */
  bodyLimit?: number;
  /**
   * Number of server processes (default 1). More than one re-runs the program N-1 times (env QALA_WORKER=i) and every
   * process listens on the same port with SO_REUSEPORT (Linux). "auto" uses one process per CPU.
   */
  workers?: number | "auto";
};

/** Serves `app` over HTTP (node:http: the same code runs on Bun, Node and as a scriptc native binary). */
export function serve(app: App, options: ServeOptions = {}): Promise<void> {
  const port = options.port ?? 3000;
  const host = options.host ?? "0.0.0.0";
  const workers = resolveWorkers(options.workers);
  const primary = !isWorker();
  const clustered = workers > 1 || !primary;
  if (workers > 1 && primary) startWorkers(workers);
  if (!primary) watchParent();
  const limit = options.bodyLimit ?? 1024 * 1024;
  if (typeof Bun !== "undefined") {
    const bun = Bun;
    return new Promise<void>((resolve) => {
      bun.serve({
        port,
        hostname: host,
        reusePort: clustered,
        maxRequestBodySize: limit,
        idleTimeout: 0,
        websocket: bunWebSocketHandlers,
        fetch: async (req, srv) => {
          const headers: Record<string, string> = {};
          req.headers.forEach((value, key) => {
            headers[key.toLowerCase()] = value;
          });
          const url = new URL(req.url);
          if ((headers["upgrade"] ?? "").toLowerCase() === "websocket") {
            const decision = await app.upgrade(new RequestData(req.method, url.pathname + url.search, headers, "", srv.requestIP(req)?.address ?? ""));
            const handlers = decision.handlers;
            if (handlers !== null && srv.upgrade(req, { data: new BunSocketState(handlers, decision.ctx) })) return undefined;
            const refused = decision.reply ?? json({ error: { status: 400, code: "bad_request", message: "Bad WebSocket handshake", details: null } }, 400);
            return new Response(refused.body, { status: refused.status, headers: bunHeaders(refused) });
          }
          const raw = req.method === "GET" || req.method === "HEAD" ? new Uint8Array(0) : new Uint8Array(await req.arrayBuffer());
          let reply: Reply;
          try {
            reply = await app.handle(new RequestData(req.method, url.pathname + url.search, headers, "", srv.requestIP(req)?.address ?? "", raw));
          } catch {
            reply = json({ error: { status: 500, code: "internal_error", message: "Internal server error", details: null } }, 500);
          }
          if (reply instanceof StreamReply) return new Response(bunStreamBody(reply), { status: reply.status, headers: bunHeaders(reply) });
          return new Response(reply.body, { status: reply.status, headers: bunHeaders(reply) });
        },
      });
      if (primary) app.logger.info(`Qala listening on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`, { routes: app.routes.length, workers });
      resolve();
    });
  }
  const server = createServer((req, res) => {
    const closed = new CloseSignal();
    req.socket.on("close", () => closed.fire());
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) {
        rejected = true;
        write(res, json({ error: { status: 413, code: "payload_too_large", message: "Request body too large", details: null } }, 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      const body: Uint8Array = chunks.length === 0 ? new Uint8Array(0) : Buffer.concat(chunks);
      app.handle(toRequest(req, body)).then(
        (reply) => write(res, reply, closed),
        () => write(res, json({ error: { status: 500, code: "internal_error", message: "Internal server error", details: null } }, 500)),
      );
    });
  });
  server.on("upgrade", (req, socket, head) => {
    nodeUpgrade(app, toRequest(req, new Uint8Array(0)), socket, head).catch(() => socket.destroy());
  });
  return new Promise<void>((resolve) => {
    const onListening = (): void => {
      if (primary) app.logger.info(`Qala listening on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`, { routes: app.routes.length, workers });
      resolve();
    };
    if (clustered) server.listen({ port, host, reusePort: true }, onListening);
    else server.listen(port, host, onListening);
  });
}

function toRequest(req: IncomingMessage, body: Uint8Array): RequestData {
  const headers: Record<string, string> = {};
  const raw = req.headers;
  for (const key of Object.keys(raw)) {
    const value: unknown = raw[key];
    if (typeof value === "string") headers[key.toLowerCase()] = value;
    else if (value !== undefined) headers[key.toLowerCase()] = String(value);
  }
  return new RequestData(req.method ?? "GET", req.url ?? "/", headers, "", req.socket.remoteAddress ?? "", body);
}

function write(res: ServerResponse, reply: Reply, closed: CloseSignal | null = null): void {
  if (reply instanceof StreamReply) {
    writeNodeStream(res, closed ?? new CloseSignal(), reply, reply.cookies.length === 0 ? reply.headers : withCookies(reply));
    return;
  }
  if (reply.cookies.length === 0) res.writeHead(reply.status, reply.headers);
  else res.writeHead(reply.status, withCookies(reply));
  res.end(reply.body);
}

/** Response headers with `set-cookie` as an array (one header line per cookie). */
function withCookies(reply: Reply): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const key of Object.keys(reply.headers)) headers[key] = reply.headers[key]!;
  headers["set-cookie"] = reply.cookies;
  return headers;
}

/** Response headers for Bun's `Response`, with one `set-cookie` per cookie. */
function bunHeaders(reply: Reply): Headers {
  const out = new Headers(reply.headers);
  for (const cookie of reply.cookies) out.append("set-cookie", cookie);
  return out;
}
