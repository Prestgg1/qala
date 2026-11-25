import { Database, type Context, type Middleware, type Reply } from "@qala/core";
import { csrfSecret, hashToken, isToken, maskToken, newToken } from "./tokens";

/** The migration that creates the sessions table (also shipped as `migrations/0001_qala_sessions.sql`). */
export const SESSIONS_MIGRATION = `create table if not exists qala_sessions (
  id text primary key,
  user_id text,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip text not null default '',
  user_agent text not null default ''
);
create index if not exists qala_sessions_user_id on qala_sessions (user_id);
create index if not exists qala_sessions_expires_at on qala_sessions (expires_at);
`;

export type SessionOptions = {
  /** Cookie name (default `__Host-qala_session`, or `qala_session` when `secure` is false). */
  cookieName?: string;
  /** Secure cookie attribute (default true). Turn off only for plain-HTTP development on hosts other than localhost. */
  secure?: boolean;
  /** SameSite attribute (default "lax"). */
  sameSite?: "strict" | "lax" | "none";
  /** Seconds without a request after which a session ends (default 2 h). */
  idleTimeout?: number;
  /** Seconds after creation after which a session ends whatever happens (default 7 days). */
  absoluteTimeout?: number;
  /** Seconds between `last_seen_at` writes for an unchanged session (default 60). */
  touchInterval?: number;
  /** Seconds between opportunistic deletions of expired rows, run in the background of a request (default 1 h; 0 = never). */
  cleanupInterval?: number;
  /** Table name (default `qala_sessions`). */
  table?: string;
};

/** Settings with every default applied. */
export class SessionConfig {
  readonly cookieName: string;
  readonly secure: boolean;
  readonly sameSite: "strict" | "lax" | "none";
  readonly idleTimeout: number;
  readonly absoluteTimeout: number;
  readonly touchInterval: number;
  readonly cleanupInterval: number;
  readonly table: string;

  constructor(options: SessionOptions) {
    this.secure = options.secure ?? true;
    this.cookieName = options.cookieName ?? (this.secure ? "__Host-qala_session" : "qala_session");
    if (this.cookieName.startsWith("__Host-") && !this.secure) throw new Error("A __Host- cookie must be Secure: pick another cookieName or keep secure: true");
    if (this.cookieName.startsWith("__Secure-") && !this.secure) throw new Error("A __Secure- cookie must be Secure");
    this.sameSite = options.sameSite ?? "lax";
    if (this.sameSite === "none" && !this.secure) throw new Error("SameSite=None needs secure: true");
    this.idleTimeout = options.idleTimeout ?? 7200;
    this.absoluteTimeout = options.absoluteTimeout ?? 604800;
    this.touchInterval = options.touchInterval ?? 60;
    this.cleanupInterval = options.cleanupInterval ?? 3600;
    this.table = options.table ?? "qala_sessions";
    if (!/^[a-z_][a-z0-9_]*$/.test(this.table)) throw new Error(`Invalid session table name: ${this.table}`);
    if (!(this.idleTimeout > 0) || !(this.absoluteTimeout > 0)) throw new RangeError("idleTimeout and absoluteTimeout must be positive");
  }
}

/**
 * One visitor's session. Changes are kept in memory and written once, after the handler, by the `sessions()`
 * middleware; nothing is stored for a visitor until something is set (or a CSRF token is asked for).
 */
export class Session {
  /** The cookie value (empty until the session exists). Never log it. */
  private token: string;
  /** The row id (SHA-256 of the token), empty until the session exists. */
  private hash: string;
  /** The row id this request loaded, kept to delete it on rotation or destroy. */
  private readonly loadedHash: string;
  private userIdValue: string | null;
  private readonly values: Record<string, string>;
  private dirty = false;
  private destroyed = false;
  private created: number;

  constructor(token: string, userId: string | null, data: Record<string, string>, createdAt: number) {
    this.token = token;
    this.hash = token === "" ? "" : hashToken(token);
    this.loadedHash = this.hash;
    this.userIdValue = userId;
    this.values = data;
    this.created = createdAt;
  }

  /** The signed-in user's id (set by `login`), or null. */
  get userId(): string | null {
    return this.userIdValue;
  }

  /** Whether a session row exists or will be written at the end of this request. */
  get exists(): boolean {
    return this.hash !== "" && !this.destroyed;
  }

  /** The row id (hash of the token), "" when there is no session. Safe to log. */
  get id(): string {
    return this.destroyed ? "" : this.hash;
  }

  /** Milliseconds since the epoch when the session was created (0 for no session). */
  get createdAt(): number {
    return this.created;
  }

  get(key: string): string | undefined {
    return this.values[key];
  }

  /** Stores a string (JSON-encode anything else); creates the session if needed. */
  set(key: string, value: string): void {
    this.ensure();
    this.values[key] = value;
    this.dirty = true;
  }

  unset(key: string): void {
    if (!(key in this.values)) return;
    delete this.values[key];
    this.dirty = true;
  }

  /** A copy of all stored values. */
  all(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of Object.keys(this.values)) out[key] = this.values[key]!;
    return out;
  }

  /**
   * Signs `userId` in: issues a brand-new token (the old one stops working, which defeats session fixation), keeps
   * the stored values and restarts the absolute lifetime.
   */
  login(userId: string): void {
    this.regenerate();
    this.userIdValue = userId;
  }

  /** Signs out and deletes the session (the cookie is cleared). */
  logout(): void {
    this.destroy();
  }

  /** Issues a new token for this session, keeping its values; the old token stops working. */
  regenerate(): void {
    this.destroyed = false;
    this.token = newToken();
    this.hash = hashToken(this.token);
    this.created = Date.now();
    this.dirty = true;
  }

  /** Deletes the session and its values; the cookie is cleared at the end of the request. */
  destroy(): void {
    this.destroyed = true;
    this.userIdValue = null;
    for (const key of Object.keys(this.values)) delete this.values[key];
    this.dirty = true;
  }

  /**
   * A CSRF token for forms (`<input type="hidden" name="_csrf">`) and the `x-csrf-token` header. Every call returns
   * a different string; all verify until the session rotates. Creates the session if needed.
   */
  csrfToken(): string {
    this.ensure();
    return maskToken(csrfSecret(this.token));
  }

  /** The unmasked CSRF secret (empty without a session). */
  csrfSecret(): Uint8Array {
    if (!this.exists) return new Uint8Array(0);
    return csrfSecret(this.token);
  }

  private ensure(): void {
    if (this.hash === "" || this.destroyed) this.regenerate();
  }

  // ----- for the store ------------------------------------------------------------------------------------------
  /** @internal */ cookieValue(): string {
    return this.token;
  }
  /** @internal */ previousId(): string {
    return this.loadedHash;
  }
  /** @internal */ isDirty(): boolean {
    return this.dirty;
  }
  /** @internal */ isDestroyed(): boolean {
    return this.destroyed;
  }
  /** @internal */ isRotated(): boolean {
    return this.hash !== this.loadedHash;
  }
}

/** Reads and writes sessions in PostgreSQL. */
export class SessionStore {
  readonly config: SessionConfig;
  private lastCleanup = Date.now();

  constructor(
    readonly db: Database,
    options: SessionOptions = {},
  ) {
    this.config = new SessionConfig(options);
  }

  /** Creates the table if it does not exist (prefer the migration; this is for tests and scripts). */
  async install(): Promise<void> {
    if (this.config.table !== "qala_sessions") throw new Error("install() only creates the default table; use the migration SQL for a custom name");
    for (const statement of SESSIONS_MIGRATION.split(";")) if (statement.trim() !== "") await this.db.execute(statement);
  }

  /** The live session for a cookie value, or null (unknown, malformed, idle too long or past its absolute expiry). */
  async load(token: string): Promise<Session | null> {
    if (!isToken(token)) return null;
    const rows = await this.db.query(
      `select user_id, data::text as data, (extract(epoch from created_at) * 1000)::float8 as created, (extract(epoch from now() - last_seen_at))::float8 as idle from ${this.config.table} where id = $1 and expires_at > now() and last_seen_at > now() - make_interval(secs => $2)`,
      [hashToken(token), this.config.idleTimeout],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const userId = row["user_id"];
    const raw = row["data"];
    const created = row["created"];
    const session = new Session(token, typeof userId === "string" ? userId : null, parseData(typeof raw === "string" ? raw : "{}"), typeof created === "number" ? created : 0);
    const idle = row["idle"];
    if (typeof idle === "number" && idle >= this.config.touchInterval) this.pendingTouch.add(session.id);
    return session;
  }

  private readonly pendingTouch = new Set<string>();

  /** Writes what changed in `session` during a request; returns the `Set-Cookie` action to take. */
  async commit(session: Session, ip: string, userAgent: string): Promise<string> {
    const table = this.config.table;
    const previous = session.previousId();
    if (session.isDestroyed()) {
      if (previous !== "") await this.db.execute(`delete from ${table} where id = $1`, [previous]);
      this.pendingTouch.delete(previous);
      return previous === "" ? "none" : "clear";
    }
    if (session.isRotated()) {
      if (previous !== "") {
        await this.db.execute(`delete from ${table} where id = $1`, [previous]);
        this.pendingTouch.delete(previous);
      }
      await this.db.execute(
        `insert into ${table} (id, user_id, data, ip, user_agent, expires_at) values ($1, $2, $3::jsonb, $4, $5, now() + make_interval(secs => $6))`,
        [session.id, session.userId, JSON.stringify(session.all()), ip, userAgent.slice(0, 512), this.config.absoluteTimeout],
      );
      return "set";
    }
    if (session.isDirty()) {
      await this.db.execute(`update ${table} set user_id = $2, data = $3::jsonb, last_seen_at = now(), ip = $4, user_agent = $5 where id = $1`, [
        session.id,
        session.userId,
        JSON.stringify(session.all()),
        ip,
        userAgent.slice(0, 512),
      ]);
      this.pendingTouch.delete(session.id);
      return "none";
    }
    if (this.pendingTouch.has(session.id)) {
      this.pendingTouch.delete(session.id);
      await this.db.execute(`update ${table} set last_seen_at = now(), ip = $2, user_agent = $3 where id = $1`, [session.id, ip, userAgent.slice(0, 512)]);
    }
    return "none";
  }

  /** Ends every session of `userId` ("log out everywhere"), except the session with row id `exceptId` if given. */
  async destroyUser(userId: string, exceptId: string = ""): Promise<number> {
    return this.db.execute(`delete from ${this.config.table} where user_id = $1 and id <> $2`, [userId, exceptId]);
  }

  /** How many live sessions `userId` has. */
  async countUser(userId: string): Promise<number> {
    const rows = await this.db.query(`select count(*)::int as n from ${this.config.table} where user_id = $1 and expires_at > now() and last_seen_at > now() - make_interval(secs => $2)`, [userId, this.config.idleTimeout]);
    const n = rows[0]?.["n"];
    return typeof n === "number" ? n : 0;
  }

  /** Deletes expired and idle rows; returns how many. */
  async cleanup(): Promise<number> {
    this.lastCleanup = Date.now();
    return this.db.execute(`delete from ${this.config.table} where expires_at <= now() or last_seen_at <= now() - make_interval(secs => $1)`, [this.config.idleTimeout]);
  }

  /** Runs `cleanup()` in the background when `cleanupInterval` has passed since the last run. */
  maybeCleanup(): void {
    if (this.config.cleanupInterval <= 0) return;
    if (Date.now() - this.lastCleanup < this.config.cleanupInterval * 1000) return;
    this.lastCleanup = Date.now();
    this.cleanup().then(
      () => {},
      () => {},
    );
  }
}

function parseData(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(text) as Record<string, string>;
  } catch {
    return out;
  }
  for (const key of Object.keys(parsed)) {
    const value = parsed[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Key under which the request's `Session` is kept on the context. */
export const SESSION_KEY = "qala.session";
const STORE_KEY = "qala.session.store";

/**
 * Global middleware: loads the session named by the cookie, puts it on the context (`session(ctx)`) and, after the
 * handler, writes the changes and sets or clears the cookie. Uses the app's `Database` unless a store is given.
 */
export function sessions(options: SessionOptions = {}, store: SessionStore | null = null): Middleware {
  let resolved: SessionStore | null = store;
  const config = new SessionConfig(options);
  return async (ctx: Context, next: () => Promise<Reply>): Promise<Reply> => {
    if (resolved === null) resolved = new SessionStore(ctx.service(Database), options);
    const active = resolved;
    ctx.set(STORE_KEY, active);
    const cookie = ctx.cookie(config.cookieName);
    let loaded: Session | null = null;
    if (cookie !== undefined && cookie !== "") loaded = await active.load(cookie);
    const current = loaded === null ? new Session("", null, {}, 0) : loaded;
    // A cookie that no longer names a live session is cleared so the browser stops sending it.
    const stale = cookie !== undefined && loaded === null;
    ctx.set(SESSION_KEY, current);
    active.maybeCleanup();
    try {
      return await next();
    } finally {
      const action = await active.commit(current, ctx.request.ip, ctx.header("user-agent") ?? "");
      if (action === "set") {
        ctx.setCookie(config.cookieName, current.cookieValue(), { httpOnly: true, secure: config.secure, sameSite: config.sameSite, path: "/", maxAge: config.absoluteTimeout });
      } else if (action === "clear" || (stale && !current.exists)) {
        ctx.clearCookie(config.cookieName, { httpOnly: true, secure: config.secure, sameSite: config.sameSite, path: "/" });
      }
    }
  };
}

/** The request's session (an empty one, never null, when there is no cookie). Needs the `sessions()` middleware. */
export function session(ctx: Context): Session {
  const value = ctx.get(SESSION_KEY);
  if (value instanceof Session) return value;
  throw new Error("No session on this request: add sessions() to the global middleware in app/kernel.ts");
}

/** The store the `sessions()` middleware uses, for "log out everywhere" and cleanup from handlers. */
export function sessionStore(ctx: Context): SessionStore {
  const value = ctx.get(STORE_KEY);
  if (value instanceof SessionStore) return value;
  throw new Error("No session store on this request: add sessions() to the global middleware in app/kernel.ts");
}

/** Ends every session of the current user, including this one when `keepCurrent` is false (default true). */
export async function logoutEverywhere(ctx: Context, keepCurrent: boolean = true): Promise<number> {
  const current = session(ctx);
  const userId = current.userId;
  if (userId === null) return 0;
  const n = await sessionStore(ctx).destroyUser(userId, keepCurrent ? current.previousId() : "");
  if (!keepCurrent) current.destroy();
  return n;
}
