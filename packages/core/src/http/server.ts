import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { App } from "./app";
import { RequestData } from "./context";
import { json, type Reply } from "./reply";
import { isWorker, resolveWorkers, startWorkers, watchParent } from "./cluster";

/** The part of `Bun.serve` that Qala uses (Bun's node:http ignores `reusePort`, so clustered Bun servers use Bun.serve). */
type BunLike = {
  serve(options: {
    port: number;
    hostname: string;
    reusePort: boolean;
    maxRequestBodySize: number;
    fetch(req: Request, server: { requestIP(req: Request): { address: string } | null }): Promise<Response>;
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
  if (clustered && typeof Bun !== "undefined") {
    const bun = Bun;
    return new Promise<void>((resolve) => {
      bun.serve({
        port,
        hostname: host,
        reusePort: true,
        maxRequestBodySize: limit,
        fetch: async (req, srv) => {
          const headers: Record<string, string> = {};
          req.headers.forEach((value, key) => {
            headers[key.toLowerCase()] = value;
          });
          const url = new URL(req.url);
          const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
          let reply: Reply;
          try {
            reply = await app.handle(new RequestData(req.method, url.pathname + url.search, headers, body, srv.requestIP(req)?.address ?? ""));
          } catch {
            reply = json({ error: { status: 500, code: "internal_error", message: "Internal server error", details: null } }, 500);
          }
          return new Response(reply.body, { status: reply.status, headers: reply.headers });
        },
      });
      if (primary) app.logger.info(`Qala listening on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`, { routes: app.routes.length, workers });
      resolve();
    });
  }
  const server = createServer((req, res) => {
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
      const body = chunks.length === 0 ? "" : Buffer.concat(chunks).toString("utf8");
      app.handle(toRequest(req, body)).then(
        (reply) => write(res, reply),
        () => write(res, json({ error: { status: 500, code: "internal_error", message: "Internal server error", details: null } }, 500)),
      );
    });
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

function toRequest(req: IncomingMessage, body: string): RequestData {
  const headers: Record<string, string> = {};
  const raw = req.headers;
  for (const key of Object.keys(raw)) {
    const value: unknown = raw[key];
    if (typeof value === "string") headers[key.toLowerCase()] = value;
    else if (value !== undefined) headers[key.toLowerCase()] = String(value);
  }
  return new RequestData(req.method ?? "GET", req.url ?? "/", headers, body, req.socket.remoteAddress ?? "");
}

function write(res: ServerResponse, reply: Reply): void {
  res.writeHead(reply.status, reply.headers);
  res.end(reply.body);
}
