import { describe, expect, test } from "bun:test";
import { acceptKey, Context, controller, createApp, type Middleware, RequestData, serve, UnauthorizedError, ws, WsConnection, WsHandlers, WsTransport } from "@qala/core";

/** A client frame (masked, as RFC 6455 requires). */
function clientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const len = payload.length;
  let head: Buffer;
  if (len < 126) head = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = (fin ? 0x80 : 0) | opcode;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = (fin ? 0x80 : 0) | opcode;
    head[1] = 0x80 | 127;
    head.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
    head.writeUInt32BE(len % 2 ** 32, 6);
  }
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i]! ^ mask[i & 3]!;
  return Buffer.concat([head, mask, body]);
}

/** Decodes the server's (unmasked) frames. */
function serverFrames(bytes: Buffer): { opcode: number; payload: Buffer }[] {
  const out: { opcode: number; payload: Buffer }[] = [];
  let at = 0;
  while (at < bytes.length) {
    const opcode = bytes[at]! & 0x0f;
    let len = bytes[at + 1]! & 0x7f;
    let p = at + 2;
    if (len === 126) {
      len = bytes.readUInt16BE(at + 2);
      p = at + 4;
    } else if (len === 127) {
      len = bytes.readUInt32BE(at + 2) * 2 ** 32 + bytes.readUInt32BE(at + 6);
      p = at + 10;
    }
    out.push({ opcode, payload: bytes.subarray(p, p + len) });
    at = p + len;
  }
  return out;
}

function echoConnection() {
  const written: Buffer[] = [];
  const events: string[] = [];
  let ended = false;
  const conn = new WsConnection(
    new WsTransport(
      (b) => written.push(b),
      () => {
        ended = true;
      },
    ),
    new WsHandlers(
      () => events.push("open"),
      (socket, data) => {
        events.push(typeof data === "string" ? `text:${data.length}` : `binary:${data.length}`);
        socket.send(data);
      },
      (_s, code) => events.push(`close:${code}`),
    ),
    new Context(new RequestData("GET", "/", {}, "", ""), "/"),
  );
  conn.start();
  return { conn, events, frames: () => serverFrames(Buffer.concat(written)), ended: () => ended };
}

describe("WebSocket framing", () => {
  test("handshake accept key (RFC 6455 example)", () => {
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  test("text, binary, 16-bit and 64-bit lengths, split across chunks", () => {
    const c = echoConnection();
    const big = Buffer.alloc(70000, 7);
    const mid = Buffer.alloc(300, 1);
    const all = Buffer.concat([clientFrame(1, Buffer.from("salam ✓")), clientFrame(2, mid), clientFrame(2, big)]);
    for (let i = 0; i < all.length; i += 1000) c.conn.receive(all.subarray(i, i + 1000));
    expect(c.events).toEqual(["open", "text:7", "binary:300", "binary:70000"]);
    const f = c.frames();
    expect(f.map((x) => [x.opcode, x.payload.length])).toEqual([[1, 9], [2, 300], [2, 70000]]);
    expect(f[0]!.payload.toString("utf8")).toBe("salam ✓");
  });

  test("fragmented message with a ping in between", () => {
    const c = echoConnection();
    c.conn.receive(clientFrame(1, Buffer.from("he"), false));
    c.conn.receive(clientFrame(9, Buffer.from("p!")));
    c.conn.receive(clientFrame(0, Buffer.from("ll"), false));
    c.conn.receive(clientFrame(0, Buffer.from("o"), true));
    expect(c.events).toEqual(["open", "text:5"]);
    const f = c.frames();
    expect(f[0]).toEqual({ opcode: 0xa, payload: Buffer.from("p!") });
    expect(f[1]!.payload.toString()).toBe("hello");
  });

  test("close handshake echoes the code and ends", () => {
    const c = echoConnection();
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(4001, 0);
    c.conn.receive(clientFrame(8, Buffer.concat([payload, Buffer.from("bye")])));
    expect(c.events).toEqual(["open", "close:4001"]);
    expect(c.frames()[0]!.opcode).toBe(8);
    expect(c.frames()[0]!.payload.readUInt16BE(0)).toBe(4001);
    expect(c.ended()).toBe(true);
  });

  test("unmasked client frames are a protocol error (1002)", () => {
    const c = echoConnection();
    c.conn.receive(Buffer.from([0x81, 0x02, 0x68, 0x69]));
    expect(c.events).toEqual(["open", "close:1002"]);
    expect(c.frames()[0]!.payload.readUInt16BE(0)).toBe(1002);
  });

  test("a vanished client reports 1006", () => {
    const c = echoConnection();
    c.conn.ended();
    expect(c.events).toEqual(["open", "close:1006"]);
  });
});

const requireToken: Middleware = async (ctx, next) => {
  if (ctx.query["token"] !== "s3cret") throw new UnauthorizedError();
  return next();
};

const closes: number[] = [];
const RoomController = controller(
  {},
  () => ({
    live: ws("/:room/live", {
      open: (socket, ctx) => socket.send(`joined ${ctx.params["room"]}`),
      message: (socket, data) => socket.send(typeof data === "string" ? `echo ${data}` : data),
      close: (_s, code) => closes.push(code),
    }),
  }),
  { middleware: [requireToken] },
);

describe("WebSocket server", () => {
  const port = 39563;
  test("start", async () => {
    await serve(createApp({ controllers: [{ name: "rooms", prefix: "/rooms", controller: RoomController }] }), { port, host: "127.0.0.1" });
  });

  test("echo text and binary through the middleware chain", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/rooms/42/live?token=s3cret`);
    socket.binaryType = "arraybuffer";
    const got: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.onerror = () => reject(new Error("ws error"));
      socket.onmessage = (e) => {
        got.push(typeof e.data === "string" ? e.data : Array.from(new Uint8Array(e.data as ArrayBuffer)));
        if (got.length === 1) socket.send("hi");
        if (got.length === 2) socket.send(new Uint8Array([1, 2, 3]));
        if (got.length === 3) socket.close(1000);
      };
      socket.onclose = () => resolve();
    });
    expect(got).toEqual(["joined 42", "echo hi", [1, 2, 3]]);
    for (let i = 0; i < 50 && closes.length === 0; i++) await Bun.sleep(10);
    expect(closes).toEqual([1000]);
  });

  test("auth rejection answers the upgrade with 401", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/rooms/42/live`, { headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
    expect(res.status).toBe(401);
  });

  test("a plain GET to a WebSocket route is 426", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/rooms/42/live?token=s3cret`);
    expect(res.status).toBe(426);
  });
});
