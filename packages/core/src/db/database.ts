import { NotFoundError } from "../errors";
import { ChangeQueue, hasEffects, ModelChange, needsBefore } from "./events";
import type { Model, ModelDef } from "./model";
import { type Connection, type ConnectionConfig, type DbRow, type DbValue, Listener, parseUrl, type PipelineItem, Pool, type QueryResult, type RawResult, type Subscription } from "./pg";

/** Runs SQL: the pool (Database) or one checked-out connection (Transaction). */
export type RunSql = (sql: string, params: DbValue[]) => Promise<QueryResult>;
/** Runs SQL and returns rows as text values per column (see `RawResult`). */
export type RunRaw = (sql: string, params: DbValue[]) => Promise<RawResult>;
/** Runs several commands in one round trip (pipelining); results in order. */
export type RunBatch = (items: PipelineItem[]) => Promise<RawResult[]>;

/** Quotes an identifier: `"user"`. */
export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function toDbValue(value: unknown): DbValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

export type Direction = "asc" | "desc";

export type FindOptions<Row, Key extends string> = {
  where?: Partial<Row>;
  /** Field and direction: `["createdAt", "desc"]`. */
  orderBy?: [Key, Direction];
  limit?: number;
  offset?: number;
};

/** Untyped options as the runtime sees them. */
type RawFind = { where: Record<string, unknown>; orderBy: [string, string] | null; limit: number | null; offset: number | null };

/**
 * The SQL engine behind `Table`: one non-generic class. Every SELECT/RETURNING names the model's columns
 * in field order, rows come back as text values and are decoded by the model (typed decoder if generated).
 */
export class TableEngine {
  /** `"id", "title", ...` in model field order. */
  private readonly selectList: string;

  constructor(
    readonly def: ModelDef,
    private readonly run: RunSql,
    private readonly runRaw: RunRaw,
    /** Where committed changes go (model events, audit, realtime); null for none. */
    private readonly changes: ChangeQueue | null = null,
  ) {
    const quoted: string[] = [];
    for (const column of def.columns) quoted.push(ident(column));
    this.selectList = quoted.join(", ");
  }

  /** Column list qualified by `alias` (`"n"."id", "n"."title"`). */
  private qualified(alias: string): string {
    const out: string[] = [];
    for (const column of this.def.columns) out.push(`${ident(alias)}.${ident(column)}`);
    return out.join(", ");
  }

  private wants(kind: "created" | "updated" | "deleted"): boolean {
    return this.changes !== null && hasEffects(this.def, kind);
  }

  private whereSql(where: Record<string, unknown>, params: DbValue[]): string {
    const parts: string[] = [];
    for (const key of Object.keys(where)) {
      const value = where[key];
      if (value === undefined) continue;
      const column = ident(this.def.columnOf(key));
      if (value === null) {
        parts.push(`${column} is null`);
      } else {
        params.push(toDbValue(value));
        parts.push(`${column} = $${params.length}`);
      }
    }
    return parts.length === 0 ? "" : ` where ${parts.join(" and ")}`;
  }

  async select(options: RawFind): Promise<unknown[]> {
    const params: DbValue[] = [];
    return this.selectWith(this.whereSql(options.where, params), params, options);
  }

  /** SELECT with a raw condition (`title ilike $1`); its `$n` placeholders refer to `params`. */
  async selectRaw(condition: string, params: DbValue[], options: RawFind): Promise<unknown[]> {
    const copy: DbValue[] = [];
    for (const p of params) copy.push(p);
    return this.selectWith(condition.trim() === "" ? "" : ` where ${condition}`, copy, options);
  }

  private async selectWith(where: string, params: DbValue[], options: RawFind): Promise<unknown[]> {
    let sql = `select ${this.selectList} from ${ident(this.def.table)}${where}`;
    if (options.orderBy !== null) {
      const dir = options.orderBy[1] === "desc" ? "desc" : "asc";
      sql += ` order by ${ident(this.def.columnOf(options.orderBy[0]))} ${dir}`;
    }
    if (options.limit !== null) {
      params.push(Math.floor(options.limit));
      sql += ` limit $${params.length}`;
    }
    if (options.offset !== null) {
      params.push(Math.floor(options.offset));
      sql += ` offset $${params.length}`;
    }
    const result = await this.runRaw(sql, params);
    return this.decodeAll(result.rows);
  }

  async count(where: Record<string, unknown>): Promise<number> {
    const params: DbValue[] = [];
    const result = await this.run(`select count(*)::int as n from ${ident(this.def.table)}${this.whereSql(where, params)}`, params);
    const n = result.rows[0]?.["n"];
    return typeof n === "number" ? n : Number(n ?? 0);
  }

  async insert(data: Record<string, unknown>): Promise<unknown> {
    const columns: string[] = [];
    const marks: string[] = [];
    const params: DbValue[] = [];
    for (const key of Object.keys(data)) {
      const value = data[key];
      if (value === undefined) continue;
      columns.push(ident(this.def.columnOf(key)));
      params.push(toDbValue(value));
      marks.push(`$${params.length}`);
    }
    const sql =
      columns.length === 0
        ? `insert into ${ident(this.def.table)} default values returning ${this.selectList}`
        : `insert into ${ident(this.def.table)} (${columns.join(", ")}) values (${marks.join(", ")}) returning ${this.selectList}`;
    const result = await this.runRaw(sql, params);
    const row = this.def.decodeValues(result.rows[0]!);
    if (this.changes !== null && this.wants("created")) await this.changes.emit(new ModelChange(this.def, "created", row, null));
    return row;
  }

  async update(id: DbValue, data: Record<string, unknown>): Promise<unknown> {
    const sets: string[] = [];
    const params: DbValue[] = [];
    for (const key of Object.keys(data)) {
      const value = data[key];
      if (value === undefined || key === this.def.primaryKey) continue;
      params.push(toDbValue(value));
      sets.push(`${ident(this.def.columnOf(key))} = $${params.length}`);
    }
    params.push(id);
    const pk = ident(this.def.columnOf(this.def.primaryKey));
    const table = ident(this.def.table);
    if (sets.length === 0) {
      const found = await this.runRaw(`select ${this.selectList} from ${table} where ${pk} = $${params.length}`, params);
      const only = found.rows[0];
      return only === undefined ? null : this.def.decodeValues(only);
    }
    const changes = this.changes;
    if (changes !== null && this.wants("updated")) {
      if (needsBefore(this.def)) {
        // The row before and after in one statement: the old row is locked and read in the same UPDATE.
        const sql = `update ${table} as "n" set ${sets.join(", ")} from (select ${this.selectList} from ${table} where ${pk} = $${params.length} for update) as "o" where "n".${pk} = "o".${pk} returning ${this.qualified("n")}, ${this.qualified("o")}`;
        const result = await this.runRaw(sql, params);
        const both = result.rows[0];
        if (both === undefined) return null;
        const width = this.def.columns.length;
        const row = this.def.decodeValues(both.slice(0, width));
        await changes.emit(new ModelChange(this.def, "updated", row, this.def.decodeValues(both.slice(width))));
        return row;
      }
      const result = await this.runRaw(`update ${table} set ${sets.join(", ")} where ${pk} = $${params.length} returning ${this.selectList}`, params);
      const raw = result.rows[0];
      if (raw === undefined) return null;
      const row = this.def.decodeValues(raw);
      await changes.emit(new ModelChange(this.def, "updated", row, null));
      return row;
    }
    const result = await this.runRaw(`update ${table} set ${sets.join(", ")} where ${pk} = $${params.length} returning ${this.selectList}`, params);
    const row = result.rows[0];
    return row === undefined ? null : this.def.decodeValues(row);
  }

  async delete(id: DbValue): Promise<boolean> {
    const pk = ident(this.def.columnOf(this.def.primaryKey));
    const changes = this.changes;
    if (changes !== null && this.wants("deleted")) {
      const result = await this.runRaw(`delete from ${ident(this.def.table)} where ${pk} = $1 returning ${this.selectList}`, [id]);
      const raw = result.rows[0];
      if (raw === undefined) return false;
      await changes.emit(new ModelChange(this.def, "deleted", this.def.decodeValues(raw), null));
      return true;
    }
    const result = await this.run(`delete from ${ident(this.def.table)} where ${pk} = $1`, [id]);
    return result.affected > 0;
  }

  private decodeAll(rows: (string | null)[][]): unknown[] {
    const out: unknown[] = [];
    for (const row of rows) out.push(this.def.decodeValues(row));
    return out;
  }
}

function rawFind(options: { where?: unknown; orderBy?: [string, Direction]; limit?: number; offset?: number }): RawFind {
  return {
    where: (options.where ?? {}) as Record<string, unknown>,
    orderBy: options.orderBy ?? null,
    limit: options.limit ?? null,
    offset: options.offset ?? null,
  };
}

/** Typed CRUD for one model: `db.table(Task).all({ where: { done: false } })`. */
export class Table<Row, Key extends string = string> {
  constructor(private readonly engine: TableEngine) {}

  async all(options: FindOptions<Row, Key> = {}): Promise<Row[]> {
    const rows = await this.engine.select(rawFind(options));
    return rows as unknown as Row[];
  }

  /**
   * Rows matching a raw SQL condition, still decoded into the model (and through its generated decoder):
   * `db.table(Task).whereRaw("title ilike $1", [`%${q}%`], { orderBy: ["createdAt", "desc"], limit: 20 })`.
   * Values always go in `params`, never into the condition text.
   */
  async whereRaw(condition: string, params: DbValue[] = [], options: Omit<FindOptions<Row, Key>, "where"> = {}): Promise<Row[]> {
    const rows = await this.engine.selectRaw(condition, params, rawFind(options));
    return rows as unknown as Row[];
  }

  async first(where: Partial<Row> = {}): Promise<Row | null> {
    const rows = await this.engine.select(rawFind({ where, limit: 1 }));
    const row = rows[0];
    if (row === undefined) return null;
    const typed = row as unknown as Row;
    return typed;
  }

  async find(id: string | number): Promise<Row | null> {
    const rows = await this.engine.select({ where: { [this.engine.def.primaryKey]: id }, orderBy: null, limit: 1, offset: null });
    const row = rows[0];
    if (row === undefined) return null;
    const typed = row as unknown as Row;
    return typed;
  }

  /** Like `find`, but a missing row throws `NotFoundError` (404). */
  async findOrFail(id: string | number): Promise<Row> {
    const row = await this.find(id);
    if (row === null) throw new NotFoundError(`${this.engine.def.table} ${id} not found`);
    return row;
  }

  count(where: Partial<Row> = {}): Promise<number> {
    return this.engine.count(where as Record<string, unknown>);
  }

  // Untyped entry points for generic framework code (e.g. `resource()`), which holds plain records:
  // asserting a record to `Partial<Row>` inside a generic function does not compile natively.

  /** `all` with a plain record filter. */
  async allRecords(where: Record<string, unknown>, orderBy: [string, Direction] | null, limit: number | null, offset: number | null): Promise<Row[]> {
    const rows = await this.engine.select({ where, orderBy, limit, offset });
    return rows as unknown as Row[];
  }

  /** `count` with a plain record filter. */
  countRecords(where: Record<string, unknown>): Promise<number> {
    return this.engine.count(where);
  }

  /** `insert` of a plain record. */
  async insertRecord(data: Record<string, unknown>): Promise<Row> {
    const row = await this.engine.insert(data);
    return row as unknown as Row;
  }

  /** `update` with a plain record. */
  async updateRecord(id: string | number, data: Record<string, unknown>): Promise<Row | null> {
    const row = await this.engine.update(id, data);
    if (row === null || row === undefined) return null;
    const typed = row as unknown as Row;
    return typed;
  }

  /** Inserts a row; omitted fields take their database defaults. Returns the stored row. */
  async insert(data: Partial<Row>): Promise<Row> {
    const row = await this.engine.insert(data as Record<string, unknown>);
    return row as unknown as Row;
  }

  /** Updates the given fields; `null` if no row has this id. */
  async update(id: string | number, data: Partial<Row>): Promise<Row | null> {
    const row = await this.engine.update(id, data as Record<string, unknown>);
    if (row === null || row === undefined) return null;
    const typed = row as unknown as Row;
    return typed;
  }

  /** Deletes a row; `false` if there was none. */
  delete(id: string | number): Promise<boolean> {
    return this.engine.delete(id);
  }
}

/** SQL on one connection inside `db.transaction(...)`. */
export class Transaction {
  constructor(
    private readonly run: RunSql,
    private readonly runRaw: RunRaw,
    private readonly runBatch: RunBatch,
    /** Model changes made in this transaction, dispatched after COMMIT. */
    readonly changes: ChangeQueue = new ChangeQueue(true),
  ) {}

  /** Several commands in one round trip on the transaction's connection (see `Database.batchRaw`). */
  batchRaw(items: PipelineItem[]): Promise<RawResult[]> {
    return this.runBatch(items);
  }

  async query(sql: string, params: DbValue[] = []): Promise<DbRow[]> {
    return (await this.run(sql, params)).rows;
  }

  async execute(sql: string, params: DbValue[] = []): Promise<number> {
    return (await this.run(sql, params)).affected;
  }

  table<Row, Key extends string>(model: Model<Row, Key, unknown, unknown>): Table<Row, Key> {
    return new Table<Row, Key>(new TableEngine(model, this.run, this.runRaw, this.changes));
  }
}

/**
 * One connection checked out of the pool for the duration of `db.session(...)`: everything runs on the
 * same server session, so session state (advisory locks, `set`, temporary tables) holds across calls.
 */
export class Session {
  constructor(private readonly connection: Connection) {}

  async query(sql: string, params: DbValue[] = []): Promise<DbRow[]> {
    return (await this.connection.query(sql, params)).rows;
  }

  async execute(sql: string, params: DbValue[] = []): Promise<number> {
    return (await this.connection.query(sql, params)).affected;
  }

  /** Runs `fn` in a transaction on this session's connection: committed if it resolves, rolled back if it throws. */
  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const connection = this.connection;
    const run: RunSql = (sql, params) => connection.query(sql, params);
    const runRaw: RunRaw = (sql, params) => connection.queryRaw(sql, params);
    const runBatch: RunBatch = (items) => connection.pipeline(items);
    const changes = new ChangeQueue(true);
    await connection.query("begin", []);
    try {
      const pending: Promise<unknown> = fn(new Transaction(run, runRaw, runBatch, changes));
      const result: unknown = await pending;
      await connection.query("commit", []);
      await changes.flush();
      // biome-ignore lint/suspicious/noExplicitAny: see Database.transaction
      const out: any = result;
      return out;
    } catch (error) {
      changes.discard();
      try {
        await connection.query("rollback", []);
      } catch {
        // the connection is gone; the server rolls back on its own
      }
      throw error;
    }
  }
}

export type DatabaseOptions = { max?: number };

/**
 * A PostgreSQL database (connection pool). Connects lazily on the first query.
 *
 *   const db = new Database(config.databaseUrl);
 *   const tasks = db.table(Task);
 *   await tasks.insert({ title: "Write docs" });
 */
export class Database {
  private readonly pool: Pool;
  private readonly config: ConnectionConfig;
  private listener: Listener | null = null;
  private readonly runPool: RunSql;
  private readonly runPoolRaw: RunRaw;
  /** Changes of single statements: dispatched as soon as they are committed. */
  private readonly changes = new ChangeQueue(false);

  constructor(url: string, options: DatabaseOptions = {}) {
    this.config = parseUrl(url);
    this.pool = new Pool(this.config, options.max ?? 10);
    this.runPool = (sql, params) => this.pool.query(sql, params);
    this.runPoolRaw = (sql, params) => this.pool.queryRaw(sql, params);
  }

  async query(sql: string, params: DbValue[] = []): Promise<DbRow[]> {
    return (await this.pool.query(sql, params)).rows;
  }

  /** Runs a statement; returns the number of affected rows. */
  async execute(sql: string, params: DbValue[] = []): Promise<number> {
    return (await this.pool.query(sql, params)).affected;
  }

  /**
   * Runs several commands in one round trip on one pooled connection (pipelining): rows as text values,
   * results in order. Each command is its own implicit transaction; if any fails, the call rejects with
   * the first failure after all responses arrived. Use `transaction` + `tx.batchRaw` for all-or-nothing.
   */
  batchRaw(items: PipelineItem[]): Promise<RawResult[]> {
    return this.pool.pipeline(items);
  }

  table<Row, Key extends string>(model: Model<Row, Key, unknown, unknown>): Table<Row, Key> {
    return new Table<Row, Key>(new TableEngine(model, this.runPool, this.runPoolRaw, this.changes));
  }

  /** Runs `fn` in a transaction: committed if it resolves, rolled back if it throws. */
  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const connection: Connection = await this.pool.acquire();
    const run: RunSql = (sql, params) => connection.query(sql, params);
    const runRaw: RunRaw = (sql, params) => connection.queryRaw(sql, params);
    const runBatch: RunBatch = (items) => connection.pipeline(items);
    let released = false;
    const changes = new ChangeQueue(true);
    try {
      await connection.query("begin", []);
      const pending: Promise<unknown> = fn(new Transaction(run, runRaw, runBatch, changes));
      const result: unknown = await pending;
      await connection.query("commit", []);
      this.pool.release(connection);
      released = true;
      // Model events of the transaction's writes, now that they are committed.
      await changes.flush();
      // biome-ignore lint/suspicious/noExplicitAny: scriptc checks `as T` at run time and lowers T=void wrongly; `any` hands the value through
      const out: any = result;
      return out;
    } catch (error) {
      changes.discard();
      if (!released) {
        try {
          await connection.query("rollback", []);
        } catch {
          // the connection is gone; the server rolls back on its own
        }
      }
      throw error;
    } finally {
      if (!released) this.pool.release(connection);
    }
  }

  /**
   * Runs `fn` with one connection pinned for its whole duration (the pool otherwise hands each query any
   * connection). Use it for session state such as advisory locks: `pg_advisory_unlock` must run on the
   * connection that took the lock. The connection goes back to the pool when `fn` settles.
   */
  async session<T>(fn: (s: Session) => Promise<T>): Promise<T> {
    const connection: Connection = await this.pool.acquire();
    try {
      const pending: Promise<unknown> = fn(new Session(connection));
      const result: unknown = await pending;
      // biome-ignore lint/suspicious/noExplicitAny: see transaction
      const out: any = result;
      return out;
    } finally {
      this.pool.release(connection);
    }
  }

  /**
   * LISTEN on `channel`: `handler` gets the payload of every NOTIFY. All channels share one dedicated
   * connection that reconnects (with backoff) and listens again after it drops; notifications sent while
   * it was down are lost. Call `unlisten()` on the result to stop.
   */
  listen(channel: string, handler: (payload: string) => void): Promise<Subscription> {
    if (this.listener === null) this.listener = new Listener(this.config);
    return this.listener.listen(channel, handler);
  }

  /** `NOTIFY channel, payload` (via `pg_notify`, so both are parameters). Payloads are limited to 8000 bytes. */
  async notify(channel: string, payload: string = ""): Promise<void> {
    await this.pool.query("select pg_notify($1, $2)", [channel, payload]);
  }

  /** Backend pid of the listener connection (0 if none), e.g. for `pg_terminate_backend` in tests. */
  listenerPid(): number {
    return this.listener === null ? 0 : this.listener.pid;
  }

  /** Closes idle connections and the listener (call on shutdown). */
  close(): void {
    if (this.listener !== null) {
      this.listener.close();
      this.listener = null;
    }
    this.pool.close();
  }
}
