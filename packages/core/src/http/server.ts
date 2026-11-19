import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { App } from "./app";
import { RequestData } from "./context";
import { json, type Reply } from "./reply";
import { isWorker, resolveWorkers, startWorkers, watchParent, type Workers } from "./cluster";
import type { Lifecycle } from "./lifecycle";
import { bunStreamBody, StreamReply, writeNodeStream } from "./stream";
import { BunSocketState, bunWebSocketHandlers, MAX_MESSAGE, nodeUpgrade, type BunSocket } from "./websocket";

/**
 * The part of `Bun.serve` that Qala uses. Under Bun the server always runs on Bun.serve: Bun's node:http ignores
 * `reusePort`, does not deliver upgraded sockets and does not report a client that disconnects from a streamed
 * response once the request body was read. The node:http path below serves Node and scriptc native binaries.
 */
type BunServer = {
  requestIP(req: Request): { address: string } | null;
  upgrade(req: Request, options: { data: unknown }): boolean;
  timeout(req: Request, seconds: number): void;
  stop(closeActiveConnections?: boolean): unknown;
};
type BunLike = {
  serve(options: {
    port: number;
    hostname: string;
    reusePort: boolean;
    maxRequestBodySize: number;
    idleTimeout: number;
    fetch(req: Request, server: BunServer): Promise<Response | undefined>;
    websocket: {
      maxPayloadLength: number;
      open(ws: BunSocket): void;
      message(ws: BunSocket, message: string | Uint8Array): void;
      close(ws: BunSocket, code: number, reason: string): void;
    };
  }): BunServer;
};
declare const Bun: BunLike | undefined;

export type ServeOptions = {
  port?: number;
  host?: string;
  /** Largest accepted request body in bytes (default 1 MiB); larger bodies get 413. */
  bodyLimit?: number;
  /**
   * Number of server processes (default 1). More than one re-runs the program N-1 times (env QALA_WORKER=i) and every
   * process listens on the same port with SO_REUSEPORT (Linux). "auto" uses one process per CPU.
   */
  workers?: number | "auto";
  /**
   * Milliseconds a client has to send a complete request head (request line and headers) after connecting or after
   * the previous response (default 10 000). Slower clients get 408 and are disconnected (slowloris protection).
   */
  headersTimeout?: number;
  /** Milliseconds a client has to send the whole request body (default 30 000); then 408. */
  requestTimeout?: number;
  /** Milliseconds an idle keep-alive connection stays open (default 5 000). */
  keepAliveTimeout?: number;
  /** Largest request head (request line and headers) in bytes (default 16 KiB); larger ones get 431. Node and native only. */
  maxHeaderSize?: number;
  /** Largest WebSocket message a client may send, all fragments together (default 16 MiB); larger closes with 1009. */
  wsMaxMessage?: number;
  /** Milliseconds `shutdown` waits for in-flight requests after SIGTERM/SIGINT (default 10 000). */
  shutdownTimeout?: number;
  /** Shut down gracefully on SIGTERM and SIGINT, then exit (default true). A second signal exits at once. */
  handleSignals?: boolean;
};

/** The limits `serve` applies, with defaults filled in. */
export class ServerLimits {
  constructor(
    readonly bodyLimit: number,
    readonly headersTimeout: number,
    readonly requestTimeout: number,
    readonly keepAliveTimeout: number,
    readonly maxHeaderSize: number,
    readonly wsMaxMessage: number,
  ) {}
}

export function serverLimits(options: ServeOptions): ServerLimits {
  return new ServerLimits(
    options.bodyLimit ?? 1024 * 1024,
    options.headersTimeout ?? 10000,
    options.requestTimeout ?? 30000,
    options.keepAliveTimeout ?? 5000,
    options.maxHeaderSize ?? 16 * 1024,
    options.wsMaxMessage ?? MAX_MESSAGE,
  );
}

function errorReply(status: number, code: string, message: string): Reply {
  return json({ error: { status, code, message, details: null } }, status);
}

/**
 * Serves `app` over HTTP (node:http: the same code runs on Bun, Node and as a scriptc native binary).
 * Resolves once the server listens. On SIGTERM/SIGINT it calls `app.shutdown()` and exits (see `handleSignals`).
 */
export function serve(app: App, options: ServeOptions = {}): Promise<void> {
  const port = options.port ?? 3000;
  const host = options.host ?? "0.0.0.0";
  const workers = resolveWorkers(options.workers);
  const primary = !isWorker();
  const clustered = workers > 1 || !primary;
  let children: Workers | null = null;
  if (workers > 1 && primary) children = startWorkers(workers);
  if (!primary) watchParent();
  const limits = serverLimits(options);
  if (options.handleSignals ?? true) handleSignals(app, children, options.shutdownTimeout ?? 10000);
  const listening = (): void => {
    if (primary) app.logger.info(`Qala listening on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`, { routes: app.routes.length, workers });
  };
  if (typeof Bun !== "undefined") {
    serveBun(Bun, app, port, host, clustered, limits);
    listening();
    return Promise.resolve();
  }
  const server = nodeServer(app, limits);
  return new Promise<void>((resolve) => {
    const onListening = (): void => {
      listening();
      resolve();
    };
    if (clustered) server.listen({ port, host, reusePort: true }, onListening);
    else server.listen(port, host, onListening);
  });
}

/** SIGTERM/SIGINT: graceful shutdown of this process and its workers, then exit (1 if it timed out). */
function handleSignals(app: App, children: Workers | null, timeout: number): void {
  let signalled = false;
  const onSignal = (): void => {
    if (signalled) process.exit(1);
    signalled = true;
    const workersGone = children === null ? Promise.resolve() : children.stop(timeout + 1000);
    app.shutdown(timeout).then(
      (drained) => workersGone.then(() => process.exit(drained ? 0 : 1)),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}

function serveBun(bun: BunLike, app: App, port: number, host: string, clustered: boolean, limits: ServerLimits): void {
  const life = app.lifecycle;
  const server = bun.serve({
    port,
    hostname: host,
    reusePort: clustered,
    maxRequestBodySize: limits.bodyLimit,
    // Bun has one idle timer per connection (seconds, at most 255); streamed responses switch it off.
    idleTimeout: Math.min(255, Math.ceil(Math.max(limits.headersTimeout, limits.keepAliveTimeout) / 1000)),
    websocket: { ...bunWebSocketHandlers, maxPayloadLength: limits.wsMaxMessage },
    fetch: async (req, srv) => {
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const url = new URL(req.url);
      if ((headers["upgrade"] ?? "").toLowerCase() === "websocket") {
        if (life.draining) {
          const gone = errorReply(503, "shutting_down", "Server is shutting down");
          return new Response(gone.body, { status: 503, headers: bunHeaders(gone, true) });
        }
        const decision = await app.upgrade(new RequestData(req.method, url.pathname + url.search, headers, "", srv.requestIP(req)?.address ?? ""));
        const handlers = decision.handlers;
        if (handlers !== null && srv.upgrade(req, { data: new BunSocketState(handlers, decision.ctx, life) })) return undefined;
        const refused = decision.reply ?? errorReply(400, "bad_request", "Bad WebSocket handshake");
        return new Response(refused.body, { status: refused.status, headers: bunHeaders(refused, life.draining) });
      }
      life.begin();
      let streaming = false;
      try {
        const raw = req.method === "GET" || req.method === "HEAD" ? new Uint8Array(0) : new Uint8Array(await req.arrayBuffer());
        let reply: Reply;
        try {
          reply = await app.handle(new RequestData(req.method, url.pathname + url.search, headers, "", srv.requestIP(req)?.address ?? "", raw));
        } catch {
          reply = errorReply(500, "internal_error", "Internal server error");
        }
        if (reply instanceof StreamReply) {
          streaming = true;
          srv.timeout(req, 0);
          const body = bunStreamBody(reply, (sink) => {
            life.addStream(sink);
            sink.onClose(() => life.end());
          });
          return new Response(body, { status: reply.status, headers: bunHeaders(reply, life.draining) });
        }
        return new Response(reply.body, { status: reply.status, headers: bunHeaders(reply, life.draining) });
      } finally {
        if (!streaming) life.end();
      }
    },
  });
  life.onStop(() => {
    server.stop(false);
  });
}

/**
 * Deadlines for request heads, keyed by connection (remote address and port). node:http in a native binary does not
 * enforce `headersTimeout`, so the server does it: a connection gets `headersTimeout` ms after it opens, and
 * `keepAliveTimeout + headersTimeout` after each response, to deliver its next complete request head.
 */
class HeadDeadlines {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly timeout: number) {}

  arm(socket: Socket, ms: number): void {
    const key = connectionKey(socket);
    this.clear(key);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        if (socket.destroyed) return;
        socket.end("HTTP/1.1 408 Request Timeout\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
        socket.destroySoon();
      }, ms),
    );
  }

  /** Starts the deadline of a new connection. */
  opened(socket: Socket): void {
    this.arm(socket, this.timeout);
  }

  disarm(socket: Socket): void {
    this.clear(connectionKey(socket));
  }

  private clear(key: string): void {
    const timer = this.timers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(key);
  }
}

function connectionKey(socket: Socket): string {
  return `${socket.remoteAddress ?? ""}:${socket.remotePort ?? 0}`;
}

function nodeServer(app: App, limits: ServerLimits): ReturnType<typeof createServer> {
  const life = app.lifecycle;
  const deadlines = new HeadDeadlines(limits.headersTimeout);
  const server = createServer({ maxHeaderSize: limits.maxHeaderSize }, (req, res) => {
    const socket = req.socket;
    deadlines.disarm(socket);
    life.begin();
    let open = true;
    res.on("close", () => {
      if (!open) return;
      open = false;
      life.end();
      if (!life.draining && !socket.destroyed) deadlines.arm(socket, limits.keepAliveTimeout + limits.headersTimeout);
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    const bodyTimer = setTimeout(() => {
      if (rejected) return;
      rejected = true;
      write(res, errorReply(408, "request_timeout", "The request body took too long"), life, null, true);
      req.destroy();
    }, limits.requestTimeout);
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > limits.bodyLimit) {
        rejected = true;
        clearTimeout(bodyTimer);
        write(res, errorReply(413, "payload_too_large", "Request body too large"), life, null, true);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      clearTimeout(bodyTimer);
      if (rejected) return;
      const body: Uint8Array = chunks.length === 0 ? new Uint8Array(0) : Buffer.concat(chunks);
      app.handle(toRequest(req, body)).then(
        (reply) => write(res, reply, life, socket),
        () => write(res, errorReply(500, "internal_error", "Internal server error"), life),
      );
    });
  });
  server.keepAliveTimeout = limits.keepAliveTimeout;
  server.on("connection", (socket: Socket) => {
    deadlines.opened(socket);
    socket.on("close", () => deadlines.disarm(socket));
  });
  // scriptc needs the exact (IncomingMessage, Socket, Buffer) listener signature.
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    deadlines.disarm(socket);
    nodeUpgrade(app, toRequest(req, new Uint8Array(0)), socket, head, limits.wsMaxMessage).catch(() => socket.destroy());
  });
  life.onStop(() => {
    server.close();
    server.closeIdleConnections();
  });
  return server;
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

/**
 * Sends a reply. Only streamed replies listen for the connection closing: a keep-alive socket serves many
 * requests, so a per-request socket listener would pile up (and keep every request's closure alive) until
 * the client disconnects. While the app shuts down (or `close` is set) the reply asks the client to disconnect.
 */
function write(res: ServerResponse, reply: Reply, life: Lifecycle, socket: Socket | null = null, close = false): void {
  const closing = close || life.draining;
  const plain = reply.cookies.length === 0 && !closing;
  if (reply instanceof StreamReply) {
    const sink = writeNodeStream(res, reply, nodeHeaders(reply, closing));
    life.addStream(sink);
    if (socket !== null) socket.on("close", () => sink.disconnected());
    return;
  }
  if (plain) res.writeHead(reply.status, reply.headers);
  else res.writeHead(reply.status, nodeHeaders(reply, closing));
  res.end(reply.body);
}

/** Response headers for node:http, with `set-cookie` as an array (one header line per cookie). */
function nodeHeaders(reply: Reply, close: boolean): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const key of Object.keys(reply.headers)) headers[key] = reply.headers[key]!;
  if (reply.cookies.length > 0) headers["set-cookie"] = reply.cookies;
  if (close) headers["connection"] = "close";
  return headers;
}

/** Response headers for Bun's `Response`, with one `set-cookie` per cookie. */
function bunHeaders(reply: Reply, close: boolean): Headers {
  const out = new Headers(reply.headers);
  for (const cookie of reply.cookies) out.append("set-cookie", cookie);
  if (close) out.set("connection", "close");
  return out;
}
