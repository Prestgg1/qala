import type { Socket } from "node:net";
/**
 * WebSockets (RFC 6455). The handshake and framing are implemented here, over a raw socket, so the same code
 * runs in a scriptc native binary and on Node; under Bun the server uses Bun's own WebSocket support with the
 * same `WsSocket` API.
 */
import { createHash } from "node:crypto";
import { ActionDef, type RuntimeHandler } from "./action";
import type { App } from "./app";
import type { Context, RequestData } from "./context";
import { Reply } from "./reply";

/** How a `WsSocket` sends: raw framing over a socket, or Bun's ServerWebSocket. */
export class WsSender {
  constructor(
    readonly send: (data: string | Uint8Array) => void,
    readonly close: (code: number, reason: string) => void,
    readonly ping: () => void,
  ) {}
}

/** One open WebSocket connection. `data` is free per-connection storage; `ctx` the upgrade request's context. */
export class WsSocket {
  readonly data = new Map<string, unknown>();
  private state = 1;

  constructor(
    private readonly sender: WsSender,
    readonly ctx: Context,
  ) {}

  /** True until `close()` is called or the connection ends. */
  get open(): boolean {
    return this.state === 1;
  }

  send(data: string | Uint8Array): void {
    if (this.state === 1) this.sender.send(data);
  }

  ping(): void {
    if (this.state === 1) this.sender.ping();
  }

  close(code = 1000, reason = ""): void {
    if (this.state !== 1) return;
    this.state = 2;
    this.sender.close(code, reason);
  }

  /** Called by the transport when the connection is gone. */
  markClosed(): void {
    this.state = 3;
  }
}

/** The callbacks of a WebSocket route. */
export class WsHandlers {
  constructor(
    readonly open: (socket: WsSocket, ctx: Context) => void,
    readonly message: (socket: WsSocket, data: Uint8Array | string) => void,
    readonly close: (socket: WsSocket, code: number, reason: string) => void,
  ) {}
}

export type WsRoute = {
  open?: (socket: WsSocket, ctx: Context) => void;
  message: (socket: WsSocket, data: Uint8Array | string) => void;
  close?: (socket: WsSocket, code: number, reason: string) => void;
};

const notHttp: RuntimeHandler = async () => new Reply(426, JSON.stringify({ error: { status: 426, code: "upgrade_required", message: "WebSocket upgrade required", details: null } }), { "content-type": "application/json; charset=utf-8", upgrade: "websocket" });

/**
 * A WebSocket route, relative to the controller prefix: `ws("/:id/live", { open, message, close })`.
 * The upgrade request runs through the global and controller middleware (auth, CORS) like any request;
 * path params are on `ctx.params`.
 */
export function ws(path: string, route: WsRoute): ActionDef {
  const open = route.open ?? ((): void => {});
  const close = route.close ?? ((): void => {});
  return new ActionDef("WS", path, null, null, null, notHttp, null, new WsHandlers(open, route.message, close));
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The `Sec-WebSocket-Accept` value for a client key. */
export function acceptKey(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

/** The raw HTTP 101 answer that completes a handshake. */
export function handshakeResponse(key: string): string {
  return `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`;
}

const REASONS: Record<number, string> = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 426: "Upgrade Required", 429: "Too Many Requests", 500: "Internal Server Error" };

/** A refused upgrade as raw HTTP/1.1 text (the socket is closed afterwards). */
export function rawHttpResponse(reply: Reply): string {
  let head = `HTTP/1.1 ${reply.status} ${REASONS[reply.status] ?? "Error"}\r\n`;
  for (const key of Object.keys(reply.headers)) head += `${key}: ${reply.headers[key]!}\r\n`;
  for (const cookie of reply.cookies) head += `set-cookie: ${cookie}\r\n`;
  head += `content-length: ${Buffer.byteLength(reply.body)}\r\nconnection: close\r\n\r\n`;
  return head + reply.body;
}

/** A byte transport under the framing (a node:net socket, or a test double). */
export class WsTransport {
  constructor(
    readonly write: (bytes: Buffer) => void,
    readonly end: () => void,
  ) {}
}

/** Encodes one unmasked server frame. */
export function encodeFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len % 4294967296, 6);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  return Buffer.concat([header, payload]);
}

/** Default largest accepted message (all fragments together): 16 MiB. */
export const MAX_MESSAGE = 16 * 1024 * 1024;

/**
 * Server side of one connection over a raw transport: parses (masked) client frames — fragmentation,
 * ping/pong, close, 7/16/64-bit lengths — and delivers whole messages to the route's handlers.
 */
export class WsConnection {
  readonly socket: WsSocket;
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private fragmentSize = 0;
  private closeSent = false;
  private finished = false;

  constructor(
    private readonly transport: WsTransport,
    private readonly handlers: WsHandlers,
    ctx: Context,
    private readonly maxMessage: number = MAX_MESSAGE,
  ) {
    this.socket = new WsSocket(
      new WsSender(
        (data) => this.sendData(data),
        (code, reason) => this.sendClose(code, reason),
        () => this.transport.write(encodeFrame(0x9, Buffer.alloc(0))),
      ),
      ctx,
    );
  }

  start(): void {
    this.handlers.open(this.socket, this.socket.ctx);
  }

  /** Bytes from the client. */
  receive(chunk: Buffer): void {
    if (this.finished) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (!this.finished) {
      const consumed = this.parseFrame();
      if (consumed === 0) break;
      this.buffer = this.buffer.subarray(consumed);
    }
  }

  /** The transport closed (client went away or after our close). */
  ended(): void {
    if (this.finished) return;
    this.finish(1006, "");
  }

  private sendData(data: string | Uint8Array): void {
    if (typeof data === "string") this.transport.write(encodeFrame(0x1, Buffer.from(data, "utf8")));
    else this.transport.write(encodeFrame(0x2, Buffer.from(data)));
  }

  private sendClose(code: number, reason: string): void {
    if (this.closeSent) return;
    this.closeSent = true;
    const r = Buffer.from(reason, "utf8");
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this.transport.write(encodeFrame(0x8, payload));
  }

  private fail(code: number, reason: string): void {
    this.sendClose(code, reason);
    this.finish(code, reason);
    this.transport.end();
  }

  private finish(code: number, reason: string): void {
    if (this.finished) return;
    this.finished = true;
    this.socket.markClosed();
    this.handlers.close(this.socket, code, reason);
  }

  /** Parses one frame at the start of the buffer; returns the bytes consumed (0 = need more). */
  private parseFrame(): number {
    const b = this.buffer;
    if (b.length < 2) return 0;
    const fin = (b[0]! & 0x80) !== 0;
    const rsv = b[0]! & 0x70;
    const opcode = b[0]! & 0x0f;
    const masked = (b[1]! & 0x80) !== 0;
    let len = b[1]! & 0x7f;
    let at = 2;
    if (len === 126) {
      if (b.length < 4) return 0;
      len = b.readUInt16BE(2);
      at = 4;
    } else if (len === 127) {
      if (b.length < 10) return 0;
      len = b.readUInt32BE(2) * 4294967296 + b.readUInt32BE(6);
      at = 10;
    }
    if (rsv !== 0 || !masked) {
      this.fail(1002, rsv !== 0 ? "Reserved bits set" : "Client frames must be masked");
      return 0;
    }
    if (opcode >= 0x8 && (!fin || len > 125)) {
      this.fail(1002, "Invalid control frame");
      return 0;
    }
    if (len > this.maxMessage || this.fragmentSize + len > this.maxMessage) {
      this.fail(1009, "Message too big");
      return 0;
    }
    if (b.length < at + 4 + len) return 0;
    const mask = b.subarray(at, at + 4);
    const payload = Buffer.alloc(len);
    const start = at + 4;
    for (let i = 0; i < len; i++) payload[i] = b[start + i]! ^ mask[i & 3]!;
    this.frame(opcode, fin, payload);
    return start + len;
  }

  private frame(opcode: number, fin: boolean, payload: Buffer): void {
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.toString("utf8", 2) : "";
      this.sendClose(code === 1005 ? 1000 : code, "");
      this.finish(code, reason);
      this.transport.end();
      return;
    }
    if (opcode === 0x9) {
      this.transport.write(encodeFrame(0xa, payload));
      return;
    }
    if (opcode === 0xa) return;
    if (opcode === 0x0) {
      if (this.fragmentOpcode === 0) {
        this.fail(1002, "Unexpected continuation frame");
        return;
      }
      this.fragments.push(payload);
      this.fragmentSize += payload.length;
      if (fin) {
        const whole = Buffer.concat(this.fragments);
        const kind = this.fragmentOpcode;
        this.fragments = [];
        this.fragmentOpcode = 0;
        this.fragmentSize = 0;
        this.deliver(kind, whole);
      }
      return;
    }
    if (opcode === 0x1 || opcode === 0x2) {
      if (this.fragmentOpcode !== 0) {
        this.fail(1002, "Expected a continuation frame");
        return;
      }
      if (fin) {
        this.deliver(opcode, payload);
      } else {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        this.fragmentSize = payload.length;
      }
      return;
    }
    this.fail(1002, "Unknown opcode");
  }

  private deliver(opcode: number, payload: Buffer): void {
    if (opcode === 0x1) this.handlers.message(this.socket, payload.toString("utf8"));
    else this.handlers.message(this.socket, new Uint8Array(payload));
  }
}

/** The part of a node:net socket the WebSocket server needs. */
export type NodeSocket = {
  write(data: string | Uint8Array): unknown;
  end(): unknown;
  destroy(): unknown;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
};

/** Node:http `upgrade` path: run the app's checks, then complete the handshake and frame the connection here. */
export async function nodeUpgrade(app: App, request: RequestData, socket: Socket, head: Buffer): Promise<void> {
  const key = request.headers["sec-websocket-key"];
  const version = request.headers["sec-websocket-version"];
  const upgradeHeader = (request.headers["upgrade"] ?? "").toLowerCase();
  if (upgradeHeader !== "websocket" || key === undefined || key === "" || (version !== undefined && version !== "13")) {
    socket.write(rawHttpResponse(new Reply(400, "Bad WebSocket handshake", { "content-type": "text/plain; charset=utf-8" })));
    socket.end();
    return;
  }
  const decision = await app.upgrade(request);
  const handlers = decision.handlers;
  if (handlers === null) {
    socket.write(rawHttpResponse(decision.reply ?? new Reply(404, "", {})));
    socket.end();
    return;
  }
  socket.write(handshakeResponse(key));
  const conn = new WsConnection(
    new WsTransport(
      (bytes) => {
        socket.write(bytes);
      },
      () => {
        socket.end();
      },
    ),
    handlers,
    decision.ctx,
  );
  socket.on("data", (chunk) => conn.receive(chunk));
  socket.on("close", () => conn.ended());
  socket.on("error", () => conn.ended());
  conn.start();
  if (head.length > 0) conn.receive(head);
}

/** Bun's ServerWebSocket, as far as Qala uses it. */
export type BunSocket = {
  data: unknown;
  send(data: string | Uint8Array): unknown;
  close(code?: number, reason?: string): unknown;
  ping(): unknown;
};

/** Per-connection state carried through Bun's upgrade (`server.upgrade(req, { data })`). */
export class BunSocketState {
  socket: WsSocket | null = null;
  constructor(
    readonly handlers: WsHandlers,
    readonly ctx: Context,
  ) {}
}

/** Bun.serve websocket callbacks driving the same handlers. */
export const bunWebSocketHandlers = {
  open(ws: BunSocket): void {
    const state = ws.data;
    if (!(state instanceof BunSocketState)) return;
    const socket = new WsSocket(
      new WsSender(
        (data) => {
          ws.send(data);
        },
        (code, reason) => {
          ws.close(code, reason);
        },
        () => {
          ws.ping();
        },
      ),
      state.ctx,
    );
    state.socket = socket;
    state.handlers.open(socket, state.ctx);
  },
  message(ws: BunSocket, message: string | Uint8Array): void {
    const state = ws.data;
    if (!(state instanceof BunSocketState) || state.socket === null) return;
    state.handlers.message(state.socket, typeof message === "string" ? message : new Uint8Array(message));
  },
  close(ws: BunSocket, code: number, reason: string): void {
    const state = ws.data;
    if (!(state instanceof BunSocketState) || state.socket === null) return;
    state.socket.markClosed();
    state.handlers.close(state.socket, code, reason);
  },
};
