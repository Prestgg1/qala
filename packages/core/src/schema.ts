/**
 * Runtime validation with static types.
 *
 * Every schema is a plain, non-generic `SchemaNode` at run time (scriptc compiles it to native code);
 * the TypeScript type it validates travels only at the type level, as a phantom `__type`.
 */

/**
 * One validation problem. `message` is English; `code` and `params` let the app translate it
 * (see i18n: `custom` marks a message written by the schema author, which is never translated).
 */
export type Issue = { path: string; message: string; code?: string; params?: Record<string, string> };

/** Validates `input`, pushing problems to `issues`. `coerce` turns query-string text into numbers/booleans. */
export type Check = (input: unknown, path: string, issues: Issue[], coerce: boolean) => unknown;

/** What a foreign key points at: a model (its table and primary key column). */
export type ColumnTarget = { readonly table: string; readonly primaryColumn: string };

export type OnDelete = "cascade" | "set null" | "restrict" | "no action";

/** A column's database metadata, set by the modifiers on a schema: `t.uuid().primary()`, `t.boolean().default(false)`. */
export class ColumnMeta {
  constructor(
    readonly isPrimary: boolean,
    /** SQL default expression (`now()`, `false`, `'todo'`), or null. */
    readonly defaultExpr: string | null,
    readonly isUnique: boolean,
    readonly isIndexed: boolean,
    /** Foreign key target table and column ("" when none). */
    readonly refTable: string,
    readonly refColumn: string,
    /** The foreign key points at the model's own table (resolved by `model()`). */
    readonly refSelf: boolean,
    readonly onDelete: string,
    /** Explicit SQL type (`varchar(200)`), or null for the kind's default. */
    readonly sqlType: string | null,
    readonly isNullable: boolean,
  ) {}
}

export const NO_COLUMN = new ColumnMeta(false, null, false, false, "", "", false, "", null, false);

/** Phantom marker class for column flags (type level only). */
export class ColumnMark {
  private readonly mark = 0;
}
/** The column has a database default, so it is optional on insert. */
export type HasDefault = { readonly __default?: () => ColumnMark };
/** The column is the primary key. */
export type IsPrimary = { readonly __primary?: () => ColumnMark };

function sqlLiteral(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

function withColumn(node: SchemaNode, meta: ColumnMeta): SchemaNode {
  return new SchemaNode(node.kind, node.check, node.optional, node.keys, node.fields, meta);
}

function meta(c: ColumnMeta, change: { isPrimary?: boolean; defaultExpr?: string; isUnique?: boolean; isIndexed?: boolean; refTable?: string; refColumn?: string; refSelf?: boolean; onDelete?: string; sqlType?: string; isNullable?: boolean }): ColumnMeta {
  return new ColumnMeta(
    change.isPrimary ?? c.isPrimary,
    change.defaultExpr ?? c.defaultExpr,
    change.isUnique ?? c.isUnique,
    change.isIndexed ?? c.isIndexed,
    change.refTable ?? c.refTable,
    change.refColumn ?? c.refColumn,
    change.refSelf ?? c.refSelf,
    change.onDelete ?? c.onDelete,
    change.sqlType ?? c.sqlType,
    change.isNullable ?? c.isNullable,
  );
}

export class SchemaNode {
  constructor(
    readonly kind: string,
    readonly check: Check,
    readonly optional: boolean,
    /** Object fields (kind "object"); empty for other kinds. */
    readonly keys: string[],
    readonly fields: SchemaNode[],
    /** Database column metadata when the schema is a model field. */
    readonly column: ColumnMeta = NO_COLUMN,
  ) {}

  // Column modifiers (for model fields). They return `this` so the validated type is kept.

  /** The primary key; a uuid key defaults to `gen_random_uuid()`, an integer key is an identity column. */
  primary(): this & IsPrimary & HasDefault {
    const def = this.kind === "uuid" ? "gen_random_uuid()" : this.column.defaultExpr ?? undefined;
    return withColumn(this, meta(this.column, { isPrimary: true, defaultExpr: def })) as this & IsPrimary & HasDefault;
  }
  /** A database default value: optional on insert. */
  default(value: string | number | boolean | null): this & HasDefault {
    return withColumn(this, meta(this.column, { defaultExpr: sqlLiteral(value) })) as this & HasDefault;
  }
  /** A database default as SQL: `.defaultSql("now()")`. */
  defaultSql(expression: string): this & HasDefault {
    return withColumn(this, meta(this.column, { defaultExpr: expression })) as this & HasDefault;
  }
  /** Defaults to the current time (`now()`). */
  now(): this & HasDefault {
    return withColumn(this, meta(this.column, { defaultExpr: "now()" })) as this & HasDefault;
  }
  unique(): this {
    return withColumn(this, meta(this.column, { isUnique: true })) as this;
  }
  index(): this {
    return withColumn(this, meta(this.column, { isIndexed: true })) as this;
  }
  /** A foreign key to another model's primary key: `.references(Project, { onDelete: "cascade" })`. */
  references(target: ColumnTarget, options: { onDelete?: OnDelete } = {}): this {
    return withColumn(this, meta(this.column, { refTable: target.table, refColumn: target.primaryColumn, onDelete: options.onDelete ?? "" })) as this;
  }
  /** A foreign key to this model's own primary key (e.g. `parentId`). */
  referencesSelf(options: { onDelete?: OnDelete } = {}): this {
    return withColumn(this, meta(this.column, { refSelf: true, onDelete: options.onDelete ?? "" })) as this;
  }
  /** An explicit SQL column type: `.type("varchar(200)")`. */
  type(sql: string): this {
    return withColumn(this, meta(this.column, { sqlType: sql })) as this;
  }
  /** The value may be `null` (a nullable column). Call it before `.default(...)`. */
  nullable(): Schema<Infer<this> | null> {
    const inner: SchemaNode = this;
    return new SchemaNode(inner.kind, (input, path, issues, coerce) => (input === null ? null : inner.check(input, path, issues, coerce)), inner.optional, inner.keys, inner.fields, meta(inner.column, { isNullable: true }));
  }
}

/** A schema validating values of type `T`. */
export type Schema<T> = SchemaNode & { readonly __type?: () => T };
/** The type a schema validates. */
export type Infer<S> = S extends { readonly __type?: () => infer T } ? T : never;

/** A shape of named fields, as passed to `t.object`. */
export type Shape = Record<string, SchemaNode>;

type OptionalKeys<S extends Shape> = { [K in keyof S]: undefined extends Infer<S[K]> ? K : never }[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
/** The object type of a shape: fields whose schema accepts `undefined` become optional. */
export type InferShape<S extends Shape> = Simplify<{ [K in RequiredKeys<S>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> }>;

function node(kind: string, check: Check, optional = false): SchemaNode {
  return new SchemaNode(kind, check, optional, [], []);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

type StringRules = { min?: number; max?: number; pattern?: RegExp; message?: string };

function stringCheck(kind: string, rules: StringRules, test: ((s: string) => boolean) | null, what: string): Check {
  return (input, path, issues) => {
    if (typeof input !== "string") {
      issues.push({ path, message: `expected ${what}, got ${describe(input)}`, code: "type", params: { expected: what, actual: describe(input) } });
      return input;
    }
    if (rules.min !== undefined && input.length < rules.min) issues.push(rules.message === undefined ? { path, message: `must be at least ${rules.min} characters`, code: "min_length", params: { min: String(rules.min) } } : { path, message: rules.message, code: "custom" });
    else if (rules.max !== undefined && input.length > rules.max) issues.push(rules.message === undefined ? { path, message: `must be at most ${rules.max} characters`, code: "max_length", params: { max: String(rules.max) } } : { path, message: rules.message, code: "custom" });
    else if (rules.pattern !== undefined && !rules.pattern.test(input)) issues.push(rules.message === undefined ? { path, message: "has an invalid format", code: "pattern" } : { path, message: rules.message, code: "custom" });
    else if (test !== null && !test(input)) issues.push(rules.message === undefined ? { path, message: `must be ${what}`, code: "format", params: { format: what } } : { path, message: rules.message, code: "custom" });
    return input;
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

type NumberRules = { min?: number; max?: number };

function numberCheck(integer: boolean, rules: NumberRules): Check {
  return (input, path, issues, coerce) => {
    let value = input;
    if (coerce && typeof value === "string" && value.trim() !== "") value = Number(value);
    if (typeof value !== "number" || Number.isNaN(value)) {
      issues.push({ path, message: `expected ${integer ? "integer" : "number"}, got ${describe(input)}`, code: "type", params: { expected: integer ? "integer" : "number", actual: describe(input) } });
      return input;
    }
    if (integer && !Number.isInteger(value)) issues.push({ path, message: "must be an integer", code: "integer" });
    else if (rules.min !== undefined && value < rules.min) issues.push({ path, message: `must be at least ${rules.min}`, code: "min", params: { min: String(rules.min) } });
    else if (rules.max !== undefined && value > rules.max) issues.push({ path, message: `must be at most ${rules.max}`, code: "max", params: { max: String(rules.max) } });
    return value;
  };
}

/** Schema builders (use the `t` instance). */
export class SchemaBuilder {
  string(rules: StringRules = {}): Schema<string> {
    return node("string", stringCheck("string", rules, null, "string"));
  }
  uuid(): Schema<string> {
    return node("uuid", stringCheck("uuid", {}, (s) => UUID.test(s), "a UUID"));
  }
  email(): Schema<string> {
    return node("email", stringCheck("email", {}, (s) => EMAIL.test(s), "an email address"));
  }
  /** An ISO-8601 date or date-time string. */
  datetime(): Schema<string> {
    return node("datetime", stringCheck("datetime", {}, (s) => ISO_DATE.test(s) && !Number.isNaN(Date.parse(s)), "an ISO date"));
  }
  number(rules: NumberRules = {}): Schema<number> {
    return node("number", numberCheck(false, rules));
  }
  integer(rules: NumberRules = {}): Schema<number> {
    return node("integer", numberCheck(true, rules));
  }
  boolean(): Schema<boolean> {
    return node("boolean", (input, path, issues, coerce) => {
      if (coerce && (input === "true" || input === "1")) return true;
      if (coerce && (input === "false" || input === "0")) return false;
      if (typeof input !== "boolean") issues.push({ path, message: `expected boolean, got ${describe(input)}`, code: "type", params: { expected: "boolean", actual: describe(input) } });
      return input;
    });
  }
  /** One of the given literal values (strings, numbers or booleans): `t.literal([0, 1, 2, 3])`. */
  literal<const V extends readonly (string | number | boolean)[]>(values: V): Schema<V[number]> {
    const allowed: (string | number | boolean)[] = [];
    for (const v of values) allowed.push(v);
    return node("literal", (input, path, issues, coerce) => {
      for (const v of allowed) {
        if (input === v) return v;
        if (coerce && typeof input === "string" && String(v) === input) return v;
      }
      issues.push({ path, message: `must be one of: ${allowed.map((v) => String(v)).join(", ")}`, code: "one_of", params: { values: allowed.map((v) => String(v)).join(", ") } });
      return input;
    });
  }
  /** One of the given string literals. */
  enum<const V extends readonly string[]>(values: V): Schema<V[number]> {
    const allowed: string[] = [];
    for (const v of values) allowed.push(v);
    return node("enum", (input, path, issues) => {
      if (typeof input !== "string" || !allowed.includes(input)) issues.push({ path, message: `must be one of: ${allowed.join(", ")}`, code: "one_of", params: { values: allowed.join(", ") } });
      return input;
    });
  }
  array<S extends SchemaNode>(item: S, rules: { min?: number; max?: number } = {}): Schema<Infer<S>[]> {
    return node("array", (input, path, issues, coerce) => {
      if (!Array.isArray(input)) {
        issues.push({ path, message: `expected array, got ${describe(input)}`, code: "type", params: { expected: "array", actual: describe(input) } });
        return input;
      }
      if (rules.min !== undefined && input.length < rules.min) issues.push({ path, message: `must have at least ${rules.min} items`, code: "min_items", params: { min: String(rules.min) } });
      if (rules.max !== undefined && input.length > rules.max) issues.push({ path, message: `must have at most ${rules.max} items`, code: "max_items", params: { max: String(rules.max) } });
      const out: unknown[] = [];
      for (let i = 0; i < input.length; i++) out.push(item.check(input[i], `${path}[${i}]`, issues, coerce));
      return out;
    });
  }
  object<S extends Shape>(shape: S): Schema<InferShape<S>> {
    const keys = Object.keys(shape);
    const fields: SchemaNode[] = [];
    for (const key of keys) fields.push(shape[key]!);
    const check: Check = (input, path, issues, coerce) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        issues.push({ path, message: `expected object, got ${describe(input)}`, code: "type", params: { expected: "object", actual: describe(input) } });
        return input;
      }
      const source = input as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        const field = fields[i]!;
        const value = source[key];
        const at = path === "" ? key : `${path}.${key}`;
        if (value === undefined) {
          if (!field.optional) issues.push({ path: at, message: "is required", code: "required" });
          continue;
        }
        out[key] = field.check(value, at, issues, coerce);
      }
      return out;
    };
    return new SchemaNode("object", check, false, keys, fields);
  }
  /** The value may be missing (`undefined`). */
  optional<S extends SchemaNode>(inner: S): Schema<Infer<S> | undefined> {
    return new SchemaNode(inner.kind, (input, path, issues, coerce) => (input === undefined ? undefined : inner.check(input, path, issues, coerce)), true, inner.keys, inner.fields, inner.column);
  }
  /** The value may be `null`. */
  nullable<S extends SchemaNode>(inner: S): Schema<Infer<S> | null> {
    return new SchemaNode(inner.kind, (input, path, issues, coerce) => (input === null ? null : inner.check(input, path, issues, coerce)), inner.optional, inner.keys, inner.fields, meta(inner.column, { isNullable: true }));
  }
  /** Anything (no validation). */
  unknown(): Schema<unknown> {
    return node("unknown", (input) => input);
  }
}

export const t = new SchemaBuilder();

/** Validates `input`; on failure returns the issues instead of a value. */
export function validate<S extends SchemaNode>(schema: S, input: unknown, coerce = false): { ok: true; value: Infer<S> } | { ok: false; issues: Issue[] } {
  const issues: Issue[] = [];
  const value = schema.check(input, "", issues, coerce);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: value as Infer<S> };
}
