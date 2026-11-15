import type { InferShape, SchemaNode, Shape } from "../schema";
import type { DbRow, DbValue } from "./pg";

/** `createdAt` → `created_at`. */
export function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** A table and its columns at run time (one non-generic class; the row type lives in `Model`). */
export class ModelDef {
  constructor(
    readonly table: string,
    /** Field names in the app (camelCase). */
    readonly keys: string[],
    /** Column names in the database (snake_case), parallel to `keys`. */
    readonly columns: string[],
    /** Schema kind of each field (string, integer, boolean, datetime, ...), parallel to `keys`. */
    readonly kinds: string[],
    readonly fields: SchemaNode[],
    /** Field name of the primary key. */
    readonly primaryKey: string,
  ) {}

  /** Index of a field name, or -1. */
  indexOf(key: string): number {
    return this.keys.indexOf(key);
  }

  columnOf(key: string): string {
    const i = this.keys.indexOf(key);
    if (i === -1) throw new Error(`${this.table}: unknown field "${key}" (fields: ${this.keys.join(", ")})`);
    return this.columns[i]!;
  }

  /** A database row (snake_case columns) as an app row (camelCase fields, decoded by schema kind). */
  decode(row: DbRow): Record<string, DbValue> {
    const out: Record<string, DbValue> = {};
    for (let i = 0; i < this.keys.length; i++) {
      const raw = row[this.columns[i]!];
      out[this.keys[i]!] = raw === undefined ? null : decodeValue(this.kinds[i]!, raw);
    }
    return out;
  }
}

/** The typed view of a model: `Row` is the row type, `Key` the union of its field names. */
export type Model<Row, Key extends string = string> = ModelDef & { readonly __row?: () => Row; readonly __key?: () => Key };
/** The row type of a model. */
export type InferModel<M> = M extends { readonly __row?: () => infer R } ? R : never;

function decodeValue(kind: string, value: DbValue): DbValue {
  if (value === null) return null;
  if (kind === "integer" || kind === "number") return typeof value === "number" ? value : Number(value);
  if (kind === "boolean") return typeof value === "boolean" ? value : value === "t" || value === "true";
  if (kind === "datetime") return toIso(String(value));
  return typeof value === "string" ? value : String(value);
}

/** Postgres timestamp text ("2026-11-15 08:00:00.123+00") → ISO-8601 ("2026-11-15T08:00:00.123Z"). */
export function toIso(text: string): string {
  let s = text.replace(" ", "T");
  if (/[+-]\d{2}$/.test(s)) s += ":00";
  const time = Date.parse(s);
  return Number.isNaN(time) ? text : new Date(time).toISOString();
}

export type ModelOptions = { primaryKey?: string };

/**
 * Declares a table:
 *
 *   export const Task = model("tasks", { id: t.uuid(), title: t.string(), done: t.boolean(), createdAt: t.datetime() });
 *   export type Task = InferModel<typeof Task>;
 *
 * Field names are camelCase in code and snake_case in the database.
 */
export function model<const S extends Shape>(table: string, shape: S, options: ModelOptions = {}): Model<InferShape<S>, Extract<keyof S, string>> {
  const keys = Object.keys(shape);
  const columns: string[] = [];
  const kinds: string[] = [];
  const fields: SchemaNode[] = [];
  for (const key of keys) {
    const field = shape[key]!;
    columns.push(snakeCase(key));
    kinds.push(field.kind);
    fields.push(field);
  }
  const primaryKey = options.primaryKey ?? "id";
  if (!keys.includes(primaryKey)) throw new Error(`model("${table}"): primary key "${primaryKey}" is not a field`);
  return new ModelDef(table, keys, columns, kinds, fields, primaryKey);
}
