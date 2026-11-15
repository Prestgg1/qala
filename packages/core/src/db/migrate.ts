import type { Database } from "./database";

export type MigrationFile = { name: string; sql: string };

/**
 * Applies pending migrations in name order, each in its own transaction, and records them in
 * `qala_migrations`. Returns the names applied now (empty if the database is up to date).
 */
export async function migrate(db: Database, files: MigrationFile[]): Promise<string[]> {
  await db.execute("create table if not exists qala_migrations (name text primary key, applied_at timestamptz not null default now())");
  const done = new Set<string>();
  for (const row of await db.query("select name from qala_migrations")) {
    const name = row["name"];
    if (typeof name === "string") done.add(name);
  }
  const pending: MigrationFile[] = [];
  for (const f of files) if (!done.has(f.name)) pending.push(f);
  pending.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const applied: string[] = [];
  for (const file of pending) {
    await db.transaction(async (tx): Promise<number> => {
      let affected = 0;
      for (const statement of splitStatements(file.sql)) affected += await tx.execute(statement);
      await tx.execute("insert into qala_migrations (name) values ($1)", [file.name]);
      return affected;
    });
    applied.push(file.name);
  }
  return applied;
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
