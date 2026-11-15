/**
 * A PostgreSQL client written for scriptc's static subset (wire protocol v3 over node:net):
 * SCRAM-SHA-256 / cleartext / trust auth, the extended query protocol with text parameters,
 * automatic prepared statements (an LRU cache per connection), pipelining, and a pool with
 * exclusive checkout (so transactions keep their connection).
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

/** A server-side prepared statement this connection created for one SQL text. */
class Statement {
  /** Result columns, from `Describe` on first use; null until it arrives. */
  columns: Column[] | null = null;
  constructor(readonly name: string) {}
}

/** One SQL command to run in a pipeline. */
export type PipelineItem = { text: string; params: DbValue[] };

/** Counters for tests and diagnostics. */
export class ConnectionStats {
  /** Parse messages sent (named or unnamed). */
  parses = 0;
  /** Commands executed (Execute messages sent). */
  executes = 0;
  /** Prepared statements closed after LRU eviction or an error. */
  closes = 0;
  /** Commands retried unprepared after 26000 / "cached plan must not change result type". */
  retries = 0;
}

/** Most prepared statements kept per connection. */
const STATEMENT_CACHE_SIZE = 256;

class Pending {
  rows: DbRow[] = [];
  /** Text values per column, in select-list order (raw mode). */
  rawRows: (string | null)[][] = [];
  columns: Column[] = [];
  error: DatabaseError | null = null;
  affected = 0;
  /** The cached statement this command used ("" when unprepared). */
  statementName = "";
  /** The statement was reused from the cache (no Parse sent for this command). */
  reused = false;
  /** Already retried once unprepared. */
  retried = false;
  constructor(
    readonly raw: boolean,
    readonly text: string,
    readonly params: DbValue[],
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
  /** SQL text → prepared statement; Map order is LRU order (oldest first). */
  private readonly statements = new Map<string, Statement>();
  private statementSeq = 0;
  /** Statements to close, sent in front of the next command. */
  private pendingCloses: string[] = [];
  readonly stats = new ConnectionStats();
  closed = false;
  /** Backend process id (from BackendKeyData); 0 until connected. */
  processId = 0;
  /** Called for every NotificationResponse (LISTEN/NOTIFY), whenever it arrives. */
  onNotification: (channel: string, payload: string) => void = () => {};
  /** Called once when the connection is gone (error, server shutdown, terminate, close()). */
  onClosed: () => void = () => {};
  private closeReported = false;

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
      const pending = new Pending(false, text, params, resolve, () => {}, reject);
      this.socket.write(Buffer.concat(this.enqueue(pending, true)));
    });
  }

  /** Like `query`, but rows come back as text values per column (see `RawResult`). */
  queryRaw(text: string, params: DbValue[]): Promise<RawResult> {
    if (this.closed) return Promise.reject(new Error("Database connection closed"));
    return new Promise<RawResult>((resolve, reject) => {
      const pending = new Pending(true, text, params, () => {}, resolve, reject);
      this.socket.write(Buffer.concat(this.enqueue(pending, true)));
    });
  }

  /**
   * Runs several commands in one round trip: every message goes out in a single socket write, with a
   * Sync after each command, so each command succeeds or fails on its own (outside a transaction each is
   * its own implicit transaction). Results come back in order. If any command fails, the call rejects
   * with the first failed command's `DatabaseError`, but only after every response has arrived, so the
   * connection stays usable.
   */
  async pipeline(items: PipelineItem[]): Promise<RawResult[]> {
    if (this.closed) throw new Error("Database connection closed");
    const results: RawResult[] = [];
    const settled: Promise<void>[] = [];
    const buffers: Buffer[] = [];
    let failure: Error | null = null;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      results.push(new RawResult([], 0));
      const done = new Promise<RawResult>((resolve, reject) => {
        const pending = new Pending(true, item.text, item.params, () => {}, resolve, reject);
        for (const b of this.enqueue(pending, true)) buffers.push(b);
      });
      settled.push(
        done.then(
          (r) => {
            results[i] = r;
          },
          (e: Error) => {
            if (failure === null) failure = e;
          },
        ),
      );
    }
    this.socket.write(Buffer.concat(buffers));
    await Promise.all(settled);
    if (failure !== null) throw failure;
    return results;
  }

  /** Queues `pending` and returns the messages for it (Close of evicted statements first). */
  private enqueue(pending: Pending, prepare: boolean): Buffer[] {
    const out: Buffer[] = [];
    for (const name of this.pendingCloses) {
      out.push(message("C", Buffer.concat([Buffer.from("S", "latin1"), cstr(name)])));
      this.stats.closes++;
    }
    this.pendingCloses = [];
    let statement = "";
    if (prepare) {
      const cached = this.statements.get(pending.text);
      if (cached !== undefined) {
        // refresh LRU position
        this.statements.delete(pending.text);
        this.statements.set(pending.text, cached);
        statement = cached.name;
        pending.reused = true;
        if (cached.columns !== null) pending.columns = cached.columns;
      } else {
        if (this.statements.size >= STATEMENT_CACHE_SIZE) {
          for (const [oldText, old] of this.statements) {
            this.statements.delete(oldText);
            out.push(message("C", Buffer.concat([Buffer.from("S", "latin1"), cstr(old.name)])));
            this.stats.closes++;
            break;
          }
        }
        this.statementSeq++;
        statement = `q${this.statementSeq}`;
        this.statements.set(pending.text, new Statement(statement));
        out.push(message("P", Buffer.concat([cstr(statement), cstr(pending.text), int16(0)])));
        out.push(message("D", Buffer.concat([Buffer.from("S", "latin1"), cstr(statement)])));
        this.stats.parses++;
      }
    } else {
      out.push(message("P", Buffer.concat([cstr(""), cstr(pending.text), int16(0)])));
      this.stats.parses++;
    }
    pending.statementName = statement;
    const bind: Buffer[] = [cstr(""), cstr(statement), int16(0), int16(pending.params.length)];
    for (const p of pending.params) {
      const v = encode(p);
      if (v === null) bind.push(int32(-1));
      else bind.push(int32(v.length), v);
    }
    bind.push(int16(0));
    out.push(message("B", Buffer.concat(bind)));
    if (statement === "") out.push(message("D", Buffer.concat([Buffer.from("P", "latin1"), cstr("")])));
    out.push(message("E", Buffer.concat([cstr(""), int32(0)])));
    out.push(message("S", Buffer.alloc(0)));
    this.stats.executes++;
    this.queue.push(pending);
    return out;
  }

  /** Forgets the cached statement for `text` (if it is still `name`) and closes it with the next command. */
  private dropStatement(text: string, name: string): void {
    const cached = this.statements.get(text);
    if (cached !== undefined && cached.name === name) {
      this.statements.delete(text);
      this.pendingCloses.push(name);
    }
  }

  private fail(err: Error): void {
    this.closed = true;
    if (!this.authenticated) this.onFail(err);
    while (this.queue.length > 0) this.queue.shift()!.reject(err);
    if (!this.closeReported) {
      this.closeReported = true;
      this.onClosed();
    }
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
    if (type === "A") {
      // NotificationResponse: int32 pid, channel\0, payload\0. Asynchronous: may arrive between any messages.
      const channelEnd = body.indexOf(0, 4);
      const payloadEnd = body.indexOf(0, channelEnd + 1);
      this.onNotification(body.toString("utf8", 4, channelEnd), body.toString("utf8", channelEnd + 1, payloadEnd));
      return;
    }
    if (type === "K") {
      this.processId = body.readInt32BE(0);
      return;
    }
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
      if (current.statementName !== "" && !current.reused) {
        const cached = this.statements.get(current.text);
        if (cached !== undefined && cached.name === current.statementName) cached.columns = current.columns;
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
      if (current.columns.length < count && current.statementName !== "") {
        // a reused statement whose Describe answer arrived after this command was queued (same pipeline)
        const cached = this.statements.get(current.text);
        if (cached !== undefined && cached.columns !== null) current.columns = cached.columns;
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
      if (done.error !== null) {
        const err = done.error;
        if (done.statementName !== "") this.dropStatement(done.text, done.statementName);
        const stale = err.code === "26000" || (err.code === "0A000" && err.message.includes("cached plan"));
        if (stale && done.statementName !== "" && !done.retried) {
          // the cached statement is gone or its result type changed: run it once more, unprepared
          const retry = new Pending(done.raw, done.text, done.params, done.resolve, done.resolveRaw, done.reject);
          retry.retried = true;
          this.stats.retries++;
          this.socket.write(Buffer.concat(this.enqueue(retry, false)));
          return;
        }
        done.reject(err);
      } else if (done.raw) done.resolveRaw(new RawResult(done.rawRows, done.affected));
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

  /** Runs `items` in one round trip on one connection (see `Connection.pipeline`). */
  async pipeline(items: PipelineItem[]): Promise<RawResult[]> {
    const c = await this.acquire();
    try {
      return await c.pipeline(items);
    } finally {
      this.release(c);
    }
  }

  close(): void {
    for (const c of this.idle) c.close();
    this.idle.length = 0;
  }
}

/** Handle returned by `listen`; `unlisten` removes this handler (and the LISTEN once no handler is left). */
export class Subscription {
  private active = true;
  constructor(
    private readonly owner: Listener,
    private readonly channel: string,
    private readonly handler: (payload: string) => void,
  ) {}

  async unlisten(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    await this.owner.remove(this.channel, this.handler);
  }
}

function quoteChannel(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * LISTEN/NOTIFY on one dedicated connection (never taken from the pool, since LISTEN is per session).
 * Several channels share it. If the connection drops it reconnects with exponential backoff
 * (`minDelay` doubling up to `maxDelay`) and runs LISTEN again for every channel that still has a handler.
 * Notifications sent while the connection was down are lost (that is how PostgreSQL works).
 */
export class Listener {
  private readonly handlers = new Map<string, ((payload: string) => void)[]>();
  private connection: Connection | null = null;
  private connecting: Promise<void> | null = null;
  private reconnecting = false;
  private stopped = false;
  /** Backend pid of the current listener connection (0 while disconnected). */
  pid = 0;

  constructor(
    private readonly config: ConnectionConfig,
    private readonly minDelay: number = 100,
    private readonly maxDelay: number = 5000,
  ) {}

  async listen(channel: string, handler: (payload: string) => void): Promise<Subscription> {
    this.stopped = false;
    const existing = this.handlers.get(channel);
    const isNew = existing === undefined;
    if (existing === undefined) this.handlers.set(channel, [handler]);
    else existing.push(handler);
    try {
      if (this.connection === null || this.connection.closed) {
        // first use: connect (throws if impossible); while a reconnect loop runs it LISTENs on success
        if (!this.reconnecting) await this.connect();
      } else if (isNew) {
        await this.connection.query(`listen ${quoteChannel(channel)}`, []);
      }
    } catch (err) {
      await this.remove(channel, handler);
      throw err;
    }
    return new Subscription(this, channel, handler);
  }

  async remove(channel: string, handler: (payload: string) => void): Promise<void> {
    const list = this.handlers.get(channel);
    if (list === undefined) return;
    const at = list.indexOf(handler);
    if (at >= 0) list.splice(at, 1);
    if (list.length > 0) return;
    this.handlers.delete(channel);
    const c = this.connection;
    if (this.handlers.size === 0) {
      this.close();
    } else if (c !== null && !c.closed) {
      try {
        await c.query(`unlisten ${quoteChannel(channel)}`, []);
      } catch {
        // the connection dropped; the reconnect only listens to channels that still have handlers
      }
    }
  }

  /** Stops listening and closes the connection. */
  close(): void {
    this.stopped = true;
    const c = this.connection;
    this.connection = null;
    this.pid = 0;
    this.handlers.clear();
    if (c !== null) c.close();
  }

  private connect(): Promise<void> {
    if (this.connecting !== null) return this.connecting;
    const attempt = this.open();
    this.connecting = attempt;
    const clear = (): void => {
      this.connecting = null;
    };
    attempt.then(clear, clear);
    return attempt;
  }

  private async open(): Promise<void> {
    const c = new Connection(this.config);
    c.onNotification = (channel, payload) => this.dispatch(channel, payload);
    await c.open();
    try {
      for (const channel of this.handlers.keys()) await c.query(`listen ${quoteChannel(channel)}`, []);
    } catch (err) {
      c.close();
      throw err;
    }
    if (this.stopped) {
      c.close();
      return;
    }
    this.connection = c;
    this.pid = c.processId;
    c.onClosed = () => this.dropped(c);
    if (c.closed) this.dropped(c);
  }

  private dispatch(channel: string, payload: string): void {
    const list = this.handlers.get(channel);
    if (list === undefined) return;
    for (const handler of list.slice()) {
      try {
        handler(payload);
      } catch {
        // a failing handler must not break the connection or the other handlers
      }
    }
  }

  private dropped(c: Connection): void {
    if (this.connection !== c || this.stopped) return;
    this.connection = null;
    this.pid = 0;
    if (!this.reconnecting) this.reconnect();
  }

  private async reconnect(): Promise<void> {
    this.reconnecting = true;
    let delay = this.minDelay;
    while (!this.stopped && this.handlers.size > 0) {
      await sleep(delay);
      if (this.stopped) break;
      try {
        await this.connect();
        if (this.connection !== null) break;
      } catch {
        delay = Math.min(delay * 2, this.maxDelay);
      }
    }
    this.reconnecting = false;
  }
}
