import type { Database, Session, Transaction } from "./database";
import type { DbValue } from "./pg";

export type MigrationFile = { name: string; sql: string };

/** Options of `migrate` and `rollback`. */
export type MigrateOptions = {
  /** `lock_timeout` for each migration's transaction (e.g. "5s"): fail instead of queueing behind live traffic. */
  lockTimeout?: string;
  /** `statement_timeout` for each migration's transaction (e.g. "5min"). */
  statementTimeout?: string;
};

/** A migration file split at its `-- migrate:down` marker. */
export type ParsedMigration = {
  up: string;
  down: string;
  /** Whether the file has a `-- migrate:down` section with at least one statement. */
  hasDown: boolean;
};

/** One row of `migrationStatus`. */
export type MigrationState = {
  name: string;
  applied: boolean;
  /** `applied_at` as Postgres prints it; "" if pending. */
  appliedAt: string;
  /** Whether the file is missing locally (applied in the database only). */
  missing: boolean;
  hasDown: boolean;
};

/**
 * Key of the session-level advisory lock that `migrate` and `rollback` hold while they run, so two
 * deploys migrating at once take turns instead of racing.
 */
export const MIGRATION_LOCK_KEY = 7262119041;

const CREATE_TABLE = "create table if not exists qala_migrations (name text primary key, applied_at timestamptz not null default now())";

/**
 * Splits a migration into its up and down parts. Everything after a line `-- migrate:down` is the
 * down migration; an optional `-- migrate:up` line marks the start of the up part.
 */
export function parseMigration(sql: string): ParsedMigration {
  const lines = sql.split("\n");
  const up: string[] = [];
  const down: string[] = [];
  let inDown = false;
  let marked = false;
  for (const line of lines) {
    const marker = /^\s*--\s*migrate:(up|down)\s*$/i.exec(line);
    if (marker !== null) {
      const which = (marker[1] ?? "").toLowerCase();
      if (which === "down") {
        inDown = true;
        marked = true;
      } else inDown = false;
      continue;
    }
    if (inDown) down.push(line);
    else up.push(line);
  }
  const downSql = down.join("\n");
  return { up: up.join("\n"), down: downSql, hasDown: marked && splitStatements(downSql).length > 0 };
}

/** Runs `fn` on one pinned connection holding the migration advisory lock; unlocks in `finally`. */
async function locked<T>(db: Database, fn: (s: Session) => Promise<T>): Promise<T> {
  return db.session(async (s: Session): Promise<T> => {
    await s.execute(`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
    try {
      await s.execute(CREATE_TABLE);
      return await fn(s);
    } finally {
      try {
        await s.execute(`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
      } catch {
        // the connection is gone; the server released the lock with the session
      }
    }
  });
}

async function applyTimeouts(tx: Transaction, options: MigrateOptions): Promise<void> {
  const lock: DbValue = options.lockTimeout ?? "";
  const statement: DbValue = options.statementTimeout ?? "";
  if (lock !== "") await tx.execute("select set_config('lock_timeout', $1, true)", [lock]);
  if (statement !== "") await tx.execute("select set_config('statement_timeout', $1, true)", [statement]);
}

function byName(a: MigrationFile, b: MigrationFile): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Applies pending migrations in name order, each in its own transaction, and records them in
 * `qala_migrations`. Returns the names applied now (empty if the database is up to date).
 *
 * Holds a PostgreSQL advisory lock (`MIGRATION_LOCK_KEY`) on one connection for the whole run: a second
 * `migrate` started meanwhile waits, then finds nothing left to apply.
 */
export async function migrate(db: Database, files: MigrationFile[], options: MigrateOptions = {}): Promise<string[]> {
  return locked(db, async (s: Session): Promise<string[]> => {
    const done = new Set<string>();
    for (const row of await s.query("select name from qala_migrations")) {
      const name = row["name"];
      if (typeof name === "string") done.add(name);
    }
    const pending: MigrationFile[] = [];
    for (const f of files) if (!done.has(f.name)) pending.push(f);
    pending.sort(byName);
    const applied: string[] = [];
    for (const file of pending) {
      const up = parseMigration(file.sql).up;
      await s.transaction(async (tx: Transaction): Promise<number> => {
        await applyTimeouts(tx, options);
        let affected = 0;
        for (const statement of splitStatements(up)) affected += await tx.execute(statement);
        await tx.execute("insert into qala_migrations (name) values ($1)", [file.name]);
        return affected;
      });
      applied.push(file.name);
    }
    return applied;
  });
}

/**
 * Reverts the last `steps` applied migrations (most recent first), each with its `-- migrate:down`
 * section in its own transaction, deleting its `qala_migrations` row. Checks every migration first and
 * reverts nothing if one has no down section or its file is missing. Holds the same lock as `migrate`.
 * Returns the names reverted.
 */
export async function rollback(db: Database, files: MigrationFile[], steps: number = 1, options: MigrateOptions = {}): Promise<string[]> {
  return locked(db, async (s: Session): Promise<string[]> => {
    const byFile = new Map<string, MigrationFile>();
    for (const f of files) byFile.set(f.name, f);
    const rows = await s.query("select name from qala_migrations order by applied_at desc, name desc limit $1", [Math.max(0, Math.floor(steps))]);
    const plan: MigrationFile[] = [];
    for (const row of rows) {
      const name = String(row["name"]);
      const file = byFile.get(name);
      if (file === undefined) throw new Error(`Cannot roll back ${name}: its migration file is missing`);
      if (!parseMigration(file.sql).hasDown) throw new Error(`Cannot roll back ${name}: it has no "-- migrate:down" section (add one with the SQL that undoes it)`);
      plan.push(file);
    }
    const reverted: string[] = [];
    for (const file of plan) {
      const down = parseMigration(file.sql).down;
      await s.transaction(async (tx: Transaction): Promise<number> => {
        await applyTimeouts(tx, options);
        let affected = 0;
        for (const statement of splitStatements(down)) affected += await tx.execute(statement);
        await tx.execute("delete from qala_migrations where name = $1", [file.name]);
        return affected;
      });
      reverted.push(file.name);
    }
    return reverted;
  });
}

/** Every migration, local or applied, in name order, with whether it is applied. Takes no lock. */
export async function migrationStatus(db: Database, files: MigrationFile[]): Promise<MigrationState[]> {
  await db.execute(CREATE_TABLE);
  const appliedAt = new Map<string, string>();
  for (const row of await db.query("select name, applied_at::text as applied_at from qala_migrations")) appliedAt.set(String(row["name"]), String(row["applied_at"]));
  const out: MigrationState[] = [];
  const seen = new Set<string>();
  const sorted = files.slice();
  sorted.sort(byName);
  for (const f of sorted) {
    seen.add(f.name);
    const at = appliedAt.get(f.name);
    out.push({ name: f.name, applied: at !== undefined, appliedAt: at ?? "", missing: false, hasDown: parseMigration(f.sql).hasDown });
  }
  for (const [name, at] of appliedAt) if (!seen.has(name)) out.push({ name, applied: true, appliedAt: at, missing: true, hasDown: false });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/**
 * Splits SQL text into statements on `;`, ignoring semicolons in quotes, `$$` bodies and comments
 * (the extended protocol runs one statement per query).
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1] ?? "";
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      current += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) j += 2;
          else break;
        } else j++;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m !== null) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        current += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ";") {
      if (current.trim() !== "") out.push(current.trim());
      current = "";
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim() !== "") out.push(current.trim());
  return out;
}
