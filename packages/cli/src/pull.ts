import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadCore } from "./run";
import { CliError, LAYOUT, color, kebab, pascal, singular, writeIfChanged } from "./util";

/** One column as read from the catalog. */
export type PulledColumn = {
  name: string;
  /** Postgres type name (`udt_name`: uuid, text, int4, _text, ...). */
  type: string;
  /** Schema of that type (to find enums). */
  typeSchema: string;
  isArray: boolean;
  nullable: boolean;
  default: string | null;
  /** `table.column` this column references, if it is a single-column foreign key. */
  references: string | null;
};

export type PulledTable = { name: string; columns: PulledColumn[]; primaryKey: string[] };
export type PulledSchema = { tables: PulledTable[]; enums: Map<string, string[]> };

type Query = (sql: string, params: string[]) => Promise<Record<string, unknown>[]>;

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** Reads tables, columns, primary keys, foreign keys and enum types of one schema. */
export async function introspect(query: Query, schema: string, only: string[] | null): Promise<PulledSchema> {
  const cols = await query(
    `select c.table_name::text as t, c.column_name::text as c, c.udt_name::text as u, c.udt_schema::text as us,
            c.data_type::text as dt, c.is_nullable::text as n, c.column_default::text as d
       from information_schema.columns c
       join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name and x.table_type = 'BASE TABLE'
      where c.table_schema = $1
      order by c.table_name, c.ordinal_position`,
    [schema],
  );
  const pks = await query(
    `select cl.relname::text as t, a.attname::text as c
       from pg_index i
       join pg_class cl on cl.oid = i.indrelid
       join pg_namespace n on n.oid = cl.relnamespace
       cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
       join pg_attribute a on a.attrelid = cl.oid and a.attnum = k.attnum
      where i.indisprimary and n.nspname = $1
      order by cl.relname, k.ord`,
    [schema],
  );
  const fks = await query(
    `select cl.relname::text as t, a.attname::text as c, rcl.relname::text as rt, ra.attname::text as rc
       from pg_constraint co
       join pg_class cl on cl.oid = co.conrelid
       join pg_namespace n on n.oid = cl.relnamespace
       join pg_class rcl on rcl.oid = co.confrelid
       join pg_attribute a on a.attrelid = co.conrelid and a.attnum = co.conkey[1]
       join pg_attribute ra on ra.attrelid = co.confrelid and ra.attnum = co.confkey[1]
      where co.contype = 'f' and n.nspname = $1 and array_length(co.conkey, 1) = 1
      order by cl.relname, a.attname`,
    [schema],
  );
  const enumRows = await query(
    `select n.nspname::text as s, t.typname::text as t, e.enumlabel::text as l
       from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace
      order by n.nspname, t.typname, e.enumsortorder`,
    [],
  );
  const enums = new Map<string, string[]>();
  for (const r of enumRows) {
    const key = `${str(r.s)}.${str(r.t)}`;
    const labels = enums.get(key) ?? [];
    labels.push(str(r.l));
    enums.set(key, labels);
  }
  const refs = new Map<string, string>();
  for (const r of fks) refs.set(`${str(r.t)}.${str(r.c)}`, `${str(r.rt)}.${str(r.rc)}`);
  const primary = new Map<string, string[]>();
  for (const r of pks) primary.set(str(r.t), [...(primary.get(str(r.t)) ?? []), str(r.c)]);

  const tables = new Map<string, PulledTable>();
  for (const r of cols) {
    const name = str(r.t);
    if (only !== null && !only.includes(name)) continue;
    let table = tables.get(name);
    if (table === undefined) {
      table = { name, columns: [], primaryKey: primary.get(name) ?? [] };
      tables.set(name, table);
    }
    const isArray = str(r.dt) === "ARRAY";
    table.columns.push({
      name: str(r.c),
      type: isArray ? str(r.u).replace(/^_/, "") : str(r.u),
      typeSchema: str(r.us),
      isArray,
      nullable: str(r.n) === "YES",
      default: r.d === null || r.d === undefined ? null : str(r.d),
      references: refs.get(`${name}.${str(r.c)}`) ?? null,
    });
  }
  return { tables: [...tables.values()], enums };
}

/** Same rule as `snakeCase` in @qala/core: `model()` maps field names to columns with it. */
const snakeCase = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const camelCase = (column: string): string => {
  const parts = column.split(/[^A-Za-z0-9]+/).filter((w) => w !== "");
  return parts.map((w, i) => (i === 0 ? w[0]!.toLowerCase() + w.slice(1) : w[0]!.toUpperCase() + w.slice(1))).join("");
};
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const lit = (s: string): string => JSON.stringify(s);

/** The `t.*` expression of a column plus an optional comment. */
export function mapType(column: PulledColumn, enums: Map<string, string[]>): { expr: string; note: string | null } {
  if (column.isArray) return { expr: "t.unknown()", note: `array (${column.type}[]) kept as unknown` };
  const labels = enums.get(`${column.typeSchema}.${column.type}`);
  if (labels !== undefined) return { expr: `t.enum([${labels.map(lit).join(", ")}])`, note: null };
  switch (column.type) {
    case "uuid":
      return { expr: "t.uuid()", note: null };
    case "text":
    case "varchar":
    case "bpchar":
    case "citext":
    case "name":
      return { expr: "t.string()", note: null };
    case "int2":
    case "int4":
      return { expr: "t.integer()", note: null };
    case "int8":
      return { expr: "t.string()", note: "bigint as string (precision)" };
    case "numeric":
      return { expr: "t.string()", note: "numeric as string (precision)" };
    case "float4":
    case "float8":
      return { expr: "t.number()", note: null };
    case "bool":
      return { expr: "t.boolean()", note: null };
    case "timestamptz":
    case "timestamp":
    case "date":
      return { expr: "t.datetime()", note: column.type === "date" ? null : column.type === "timestamp" ? "timestamp without time zone" : null };
    case "json":
    case "jsonb":
      return { expr: "t.unknown()", note: `${column.type} kept as unknown` };
    default:
      return { expr: "t.unknown()", note: `unmapped type ${column.type}` };
  }
}

export type RenderedModel = { table: string; exportName: string; file: string; content: string };
export type PullResult = { models: RenderedModel[]; columns: number; warnings: string[]; notes: string[] };

/** Turns the introspected schema into model files (deterministic: tables and columns in a fixed order). */
export function render(schema: PulledSchema): PullResult {
  const warnings: string[] = [];
  const notes: string[] = [];
  const models: RenderedModel[] = [];
  const used = new Set<string>();
  let columnCount = 0;
  const tables = [...schema.tables].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const table of tables) {
    const lines: string[] = [];
    const fields = new Map<string, string>(); // field name → column
    for (const column of table.columns) {
      const field = camelCase(column.name);
      if (field === "" || snakeCase(field) !== column.name) {
        warnings.push(`${table.name}.${column.name}: skipped (field "${field}" would map to column "${snakeCase(field)}", not "${column.name}")`);
        continue;
      }
      if (fields.has(field)) {
        warnings.push(`${table.name}.${column.name}: skipped (field "${field}" already taken by column "${fields.get(field)}")`);
        continue;
      }
      fields.set(field, column.name);
      const { expr, note } = mapType(column, schema.enums);
      const comments = [note, column.default !== null ? `default ${column.default}` : null, column.references !== null ? `references ${column.references}` : null].filter((c): c is string => c !== null);
      const key = IDENT.test(field) ? field : lit(field);
      lines.push(`  ${key}: ${column.nullable ? `t.nullable(${expr})` : expr},${comments.length > 0 ? ` // ${comments.join("; ")}` : ""}`);
    }
    let primaryKey: string | null = null;
    const head = table.primaryKey[0];
    if (head !== undefined) {
      const field = camelCase(head);
      if (fields.get(field) === head) primaryKey = field;
      else warnings.push(`${table.name}: skipped (primary key column "${head}" cannot be mapped)`);
    } else if (fields.get("id") === "id") {
      notes.push(`${table.name}: no primary key; using the "id" column`);
    } else {
      warnings.push(`${table.name}: skipped (no primary key and no "id" column)`);
    }
    if (head === undefined ? !fields.has("id") : primaryKey === null) continue;
    if (table.primaryKey.length > 1) notes.push(`${table.name}: composite primary key (${table.primaryKey.join(", ")}); using the first column "${head}"`);

    const singularKebab = kebab(singular(kebab(table.name)));
    let base = singularKebab;
    if (base === "" || used.has(base)) base = kebab(table.name);
    if (used.has(base)) base = table.name;
    used.add(base);
    let exportName = pascal(base);
    if (!/^[A-Za-z_]/.test(exportName)) exportName = `T${exportName}`;
    const options = primaryKey !== null && primaryKey !== "id" ? `, { primaryKey: ${lit(primaryKey)} }` : "";
    const composite = table.primaryKey.length > 1 ? `// composite primary key (${table.primaryKey.join(", ")}): only "${head}" is used\n` : "";
    const content =
      `// generated by qala db:pull — edit freely\n` +
      `import { model, t, type InferModel } from "@qala/core";\n\n` +
      composite +
      `export const ${exportName} = model(${lit(table.name)}, {\n${lines.join("\n")}\n}${options});\n` +
      `export type ${exportName} = InferModel<typeof ${exportName}>;\n`;
    columnCount += lines.length;
    models.push({ table: table.name, exportName, file: `${base}.model.ts`, content });
  }
  return { models, columns: columnCount, warnings, notes };
}

export function renderIndex(models: RenderedModel[]): string {
  const rows = models.map((m) => `export { ${m.exportName} } from "./${m.file.replace(/\.ts$/, "")}";`);
  return `// generated by qala db:pull — edit freely\n${rows.join("\n")}\n`;
}

export type PullOptions = { url?: string; schema?: string; tables?: string; out?: string; force?: boolean };

async function databaseUrl(root: string): Promise<string> {
  const configFile = join(root, LAYOUT.config);
  if (!existsSync(configFile)) throw new CliError(`${LAYOUT.config} is missing: add it, or pass --url postgres://...`);
  const previous = process.cwd();
  process.chdir(root); // defineConfig reads .env from the working directory
  try {
    const { config } = (await import(pathToFileURL(configFile).href)) as { config?: { databaseUrl?: string } };
    if (config === undefined || typeof config.databaseUrl !== "string") throw new CliError(`${LAYOUT.config} must export \`config\` with a \`databaseUrl\` string`);
    return config.databaseUrl;
  } finally {
    process.chdir(previous);
  }
}

/** `qala db:pull`: generate model files from an existing PostgreSQL database. */
export async function pullCommand(root: string, options: PullOptions): Promise<number> {
  const schemaName = options.schema ?? "public";
  const only = options.tables === undefined ? null : options.tables.split(",").map((s) => s.trim()).filter((s) => s !== "");
  const outDir = isAbsolute(options.out ?? "") ? options.out! : join(root, options.out ?? join(LAYOUT.domain, "schema"));
  const url = options.url ?? (await databaseUrl(root));
  const core = (await loadCore(root)) as unknown as { Database: new (url: string) => { query: Query; close(): void } };
  const db = new core.Database(url);
  let result: PullResult;
  try {
    const pulled = await introspect((sql, params) => db.query(sql, params), schemaName, only);
    if (only !== null) for (const name of only) if (!pulled.tables.some((t) => t.name === name)) throw new CliError(`table "${name}" not found in schema "${schemaName}"`);
    result = render(pulled);
  } finally {
    db.close();
  }
  if (result.models.length === 0 && result.warnings.length === 0) throw new CliError(`no tables found in schema "${schemaName}"`);
  mkdirSync(outDir, { recursive: true });
  for (const m of result.models) {
    const file = join(outDir, m.file);
    if (existsSync(file) && !options.force && readFileSync(file, "utf8") !== m.content) {
      console.log(color.yellow(`exists  ${m.file} (not overwritten; use --force)`));
      continue;
    }
    writeIfChanged(file, m.content);
    console.log(`${color.green("wrote")} ${m.file}  ${color.dim(m.table)}`);
  }
  writeIfChanged(join(outDir, "index.ts"), renderIndex(result.models));
  console.log(`${color.green("wrote")} index.ts`);
  for (const n of result.notes) console.log(color.dim(`note: ${n}`));
  for (const w of result.warnings) console.log(color.yellow(`warning: ${w}`));
  console.log(`${color.green("✓")} ${result.models.length} model${result.models.length === 1 ? "" : "s"}, ${result.columns} column${result.columns === 1 ? "" : "s"} → ${outDir}`);
  return 0;
}
