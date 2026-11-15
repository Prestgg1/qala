/**
 * A PostgreSQL client written for scriptc's static subset (wire protocol v3 over node:net):
 * SCRAM-SHA-256 / cleartext / trust auth, the extended query protocol with text parameters,
 * and a pool with exclusive checkout (so transactions keep their connection).
 */
import { connect, type Socket } from "node:net";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

export type DbValue = string | number | boolean | null;
/** A result row: column name → value (numbers and booleans decoded, everything else text). */
export type DbRow = Record<string, DbValue>;

export type ConnectionConfig = { host: string; port: number; user: string; password: string; database: string };

/** An error reported by PostgreSQL; `code` is its SQLSTATE (e.g. "23505" unique violation). */
export class DatabaseError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail: string,
  ) {
    super(message);
  }
}

/** Parses `postgres://user:pass@host:port/db`. */
export function parseUrl(url: string): ConnectionConfig {
  const m = /^postgres(?:ql)?:\/\/([^:@/]*)(?::([^@/]*))?@([^:/?]+)(?::(\d+))?\/([^?]+)/.exec(url);
  if (m === null) throw new Error("DATABASE_URL must look like postgres://user:password@host:5432/database");
  return {
    user: decodeURIComponent(m[1] ?? ""),
    password: decodeURIComponent(m[2] ?? ""),
    host: m[3] ?? "localhost",
    port: Number(m[4] ?? "5432"),
    database: decodeURIComponent(m[5] ?? ""),
  };
}

function int32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n, 0);
  return b;
}
function int16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n, 0);
  return b;
}
function cstr(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]);
}
function message(type: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(type, "latin1"), int32(body.length + 4), body]);
}
function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!;
  return out;
}

/** Text → value by type OID: int2/int4/float4/float8/oid → number, bool → boolean, the rest stays text. */
function decode(type: number, text: string): DbValue {
  if (type === 21 || type === 23 || type === 26 || type === 700 || type === 701) return Number(text);
  if (type === 16) return text === "t";
  return text;
}

function encode(value: DbValue): Buffer | null {
  if (value === null) return null;
  if (typeof value === "boolean") return Buffer.from(value ? "true" : "false", "utf8");
  return Buffer.from(String(value), "utf8");
}

class Column {
  constructor(
    readonly name: string,
    readonly type: number,
  ) {}
}

class Pending {
  rows: DbRow[] = [];
  /** Text values per column, in select-list order (raw mode). */
  rawRows: (string | null)[][] = [];
  columns: Column[] = [];
  error: DatabaseError | null = null;
  affected = 0;
  constructor(
    readonly raw: boolean,
    readonly resolve: (result: QueryResult) => void,
    readonly resolveRaw: (result: RawResult) => void,
    readonly reject: (err: Error) => void,
  ) {}
}

/** Rows as text values per column (`null` for SQL NULL), in select-list order: no type decoding, no records. */
export class RawResult {
  constructor(
    readonly rows: (string | null)[][],
    readonly affected: number,
  ) {}
}

export class QueryResult {
  constructor(
    readonly rows: DbRow[],
    /** Rows inserted/updated/deleted (from the command tag). */
    readonly affected: number,
  ) {}
}

function errorFields(body: Buffer): Map<string, string> {
  const fields = new Map<string, string>();
  let at = 0;
  while (at < body.length && body[at] !== 0) {
    const key = String.fromCharCode(body[at]!);
    const end = body.indexOf(0, at + 1);
    fields.set(key, body.toString("utf8", at + 1, end));
    at = end + 1;
  }
  return fields;
}

export class Connection {
  private readonly socket: Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly queue: Pending[] = [];
  private readonly ready: Promise<void>;
  private onReady: () => void = () => {};
  private onFail: (err: Error) => void = () => {};
  private nonce = "";
  private serverSignature = "";
  private authenticated = false;
  closed = false;

  constructor(private readonly config: ConnectionConfig) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.onReady = resolve;
      this.onFail = reject;
    });
    this.socket = connect(config.port, config.host);
    this.socket.on("connect", () => {
      const params = Buffer.concat([cstr("user"), cstr(config.user), cstr("database"), cstr(config.database), cstr("client_encoding"), cstr("UTF8"), cstr("TimeZone"), cstr("UTC"), Buffer.from([0])]);
      const body = Buffer.concat([int32(196608), params]);
      this.socket.write(Buffer.concat([int32(body.length + 4), body]));
    });
    this.socket.on("data", (chunk: Buffer) => this.receive(chunk));
    this.socket.on("error", (err: Error) => this.fail(err));
    this.socket.on("close", () => this.fail(new Error("Database connection closed")));
  }

  open(): Promise<void> {
    return this.ready;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.write(message("X", Buffer.alloc(0)));
    this.socket.end();
  }

  query(text: string, params: DbValue[]): Promise<QueryResult> {
    if (this.closed) return Promise.reject(new Error("Database connection closed"));
    return new Promise<QueryResult>((resolve, reject) => {
      this.queue.push(new Pending(false, resolve, () => {}, reject));
      this.send(text, params);
    });
  }

  /** Like `query`, but rows come back as text values per column (see `RawResult`). */
  queryRaw(text: string, params: DbValue[]): Promise<RawResult> {
    if (this.closed) return Promise.reject(new Error("Database connection closed"));
    return new Promise<RawResult>((resolve, reject) => {
      this.queue.push(new Pending(true, () => {}, resolve, reject));
      this.send(text, params);
    });
  }

  private send(text: string, params: DbValue[]): void {
    const bind: Buffer[] = [cstr(""), cstr(""), int16(0), int16(params.length)];
    for (const p of params) {
      const v = encode(p);
      if (v === null) bind.push(int32(-1));
      else bind.push(int32(v.length), v);
    }
    bind.push(int16(0));
    this.socket.write(
      Buffer.concat([
        message("P", Buffer.concat([cstr(""), cstr(text), int16(0)])),
        message("B", Buffer.concat(bind)),
        message("D", Buffer.concat([Buffer.from("P", "latin1"), cstr("")])),
        message("E", Buffer.concat([cstr(""), int32(0)])),
        message("S", Buffer.alloc(0)),
      ]),
    );
  }

  private fail(err: Error): void {
    this.closed = true;
    if (!this.authenticated) this.onFail(err);
    while (this.queue.length > 0) this.queue.shift()!.reject(err);
  }

  private receive(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 5) {
      const length = this.buffer.readInt32BE(1);
      if (this.buffer.length < length + 1) break;
      const type = String.fromCharCode(this.buffer[0]!);
      const body = this.buffer.subarray(5, length + 1);
      this.buffer = this.buffer.subarray(length + 1);
      this.handle(type, body);
    }
  }

  private handle(type: string, body: Buffer): void {
    if (type === "R") return this.auth(body);
    if (type === "T") {
      const current = this.queue[0]!;
      const count = body.readInt16BE(0);
      let at = 2;
      current.columns = [];
      for (let i = 0; i < count; i++) {
        const end = body.indexOf(0, at);
        const name = body.toString("utf8", at, end);
        at = end + 1;
        current.columns.push(new Column(name, body.readInt32BE(at + 6)));
        at += 18;
      }
      return;
    }
    if (type === "D") {
      const current = this.queue[0]!;
      const count = body.readInt16BE(0);
      let at = 2;
      if (current.raw) {
        const values: (string | null)[] = [];
        for (let i = 0; i < count; i++) {
          const len = body.readInt32BE(at);
          at += 4;
          if (len === -1) {
            values.push(null);
          } else {
            values.push(body.toString("utf8", at, at + len));
            at += len;
          }
        }
        current.rawRows.push(values);
        return;
      }
      const row: DbRow = {};
      for (let i = 0; i < count; i++) {
        const len = body.readInt32BE(at);
        at += 4;
        const col = current.columns[i]!;
        if (len === -1) {
          row[col.name] = null;
        } else {
          row[col.name] = decode(col.type, body.toString("utf8", at, at + len));
          at += len;
        }
      }
      current.rows.push(row);
      return;
    }
    if (type === "C") {
      const current = this.queue[0];
      if (current !== undefined) {
        const tag = body.toString("utf8", 0, body.length - 1).split(" ");
        const n = Number(tag[tag.length - 1]);
        current.affected = Number.isNaN(n) ? 0 : n;
      }
      return;
    }
    if (type === "E") {
      const f = errorFields(body);
      const err = new DatabaseError(f.get("M") ?? "Database error", f.get("C") ?? "", f.get("D") ?? "");
      if (!this.authenticated) return this.onFail(err);
      const current = this.queue[0];
      if (current !== undefined) current.error = err;
      return;
    }
    if (type === "Z") {
      if (!this.authenticated) {
        this.authenticated = true;
        return this.onReady();
      }
      const done = this.queue.shift();
      if (done === undefined) return;
      if (done.error !== null) done.reject(done.error);
      else if (done.raw) done.resolveRaw(new RawResult(done.rawRows, done.affected));
      else done.resolve(new QueryResult(done.rows, done.affected));
    }
  }

  private auth(body: Buffer): void {
    const code = body.readInt32BE(0);
    if (code === 0) return;
    if (code === 3) {
      this.socket.write(message("p", cstr(this.config.password)));
      return;
    }
    if (code === 10) {
      this.nonce = randomBytes(18).toString("base64");
      const first = Buffer.from(`n,,n=*,r=${this.nonce}`, "utf8");
      this.socket.write(message("p", Buffer.concat([cstr("SCRAM-SHA-256"), int32(first.length), first])));
      return;
    }
    if (code === 11) {
      const serverFirst = body.toString("utf8", 4);
      const parts = new Map<string, string>();
      for (const kv of serverFirst.split(",")) parts.set(kv.slice(0, 1), kv.slice(2));
      const salted = pbkdf2Sync(this.config.password, Buffer.from(parts.get("s") ?? "", "base64"), Number(parts.get("i")), 32, "sha256");
      const clientKey = createHmac("sha256", salted).update("Client Key").digest();
      const storedKey = createHash("sha256").update(clientKey).digest();
      const finalBare = `c=biws,r=${parts.get("r") ?? ""}`;
      const authMessage = `n=*,r=${this.nonce},${serverFirst},${finalBare}`;
      const signature = createHmac("sha256", storedKey).update(authMessage).digest();
      const proof = xor(clientKey, signature).toString("base64");
      const serverKey = createHmac("sha256", salted).update("Server Key").digest();
      this.serverSignature = createHmac("sha256", serverKey).update(authMessage).digest("base64");
      this.socket.write(message("p", Buffer.from(`${finalBare},p=${proof}`, "utf8")));
      return;
    }
    if (code === 12) {
      if (body.toString("utf8", 4) !== `v=${this.serverSignature}`) this.onFail(new Error("SCRAM: the server's signature does not match"));
      return;
    }
    this.onFail(new Error(`Unsupported PostgreSQL authentication method (${code}); use scram-sha-256, password or trust`));
  }
}

/** A fixed-size pool: each query checks a connection out exclusively and returns it when done. */
export class Pool {
  private readonly idle: Connection[] = [];
  private readonly waiting: ((c: Connection) => void)[] = [];
  private size = 0;

  constructor(
    private readonly config: ConnectionConfig,
    private readonly max: number,
  ) {}

  async acquire(): Promise<Connection> {
    while (this.idle.length > 0) {
      const c = this.idle.pop()!;
      if (!c.closed) return c;
      this.size--;
    }
    if (this.size < this.max) {
      this.size++;
      const c = new Connection(this.config);
      try {
        await c.open();
      } catch (err) {
        this.size--;
        throw err;
      }
      return c;
    }
    return new Promise<Connection>((resolve) => this.waiting.push(resolve));
  }

  release(c: Connection): void {
    if (c.closed) {
      this.size--;
      const waiter = this.waiting.shift();
      if (waiter !== undefined) this.acquire().then(waiter, () => {});
      return;
    }
    const next = this.waiting.shift();
    if (next !== undefined) next(c);
    else this.idle.push(c);
  }

  async query(text: string, params: DbValue[]): Promise<QueryResult> {
    const c = await this.acquire();
    try {
      return await c.query(text, params);
    } finally {
      this.release(c);
    }
  }

  async queryRaw(text: string, params: DbValue[]): Promise<RawResult> {
    const c = await this.acquire();
    try {
      return await c.queryRaw(text, params);
    } finally {
      this.release(c);
    }
  }

  close(): void {
    for (const c of this.idle) c.close();
    this.idle.length = 0;
  }
}
