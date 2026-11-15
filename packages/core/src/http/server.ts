import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { App } from "./app";
import { RequestData } from "./context";
import { json, type Reply } from "./reply";

export type ServeOptions = {
  port?: number;
  host?: string;
  /** Largest accepted request body in bytes (default 1 MiB). */
  bodyLimit?: number;
};

/** Serves `app` over HTTP (node:http: the same code runs on Bun, Node and as a scriptc native binary). */
export function serve(app: App, options: ServeOptions = {}): Promise<void> {
  const port = options.port ?? 3000;
  const host = options.host ?? "0.0.0.0";
  const limit = options.bodyLimit ?? 1024 * 1024;
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
    server.listen(port, host, () => {
      app.logger.info(`Qala listening on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`, { routes: app.routes.length });
      resolve();
    });
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
