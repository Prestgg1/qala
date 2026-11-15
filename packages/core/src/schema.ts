/**
 * Runtime validation with static types.
 *
 * Every schema is a plain, non-generic `SchemaNode` at run time (scriptc compiles it to native code);
 * the TypeScript type it validates travels only at the type level, as a phantom `__type`.
 */

export type Issue = { path: string; message: string };

/** Validates `input`, pushing problems to `issues`. `coerce` turns query-string text into numbers/booleans. */
export type Check = (input: unknown, path: string, issues: Issue[], coerce: boolean) => unknown;

export class SchemaNode {
  constructor(
    readonly kind: string,
    readonly check: Check,
    readonly optional: boolean,
    /** Object fields (kind "object"); empty for other kinds. */
    readonly keys: string[],
    readonly fields: SchemaNode[],
  ) {}
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
      issues.push({ path, message: `expected ${what}, got ${describe(input)}` });
      return input;
    }
    if (rules.min !== undefined && input.length < rules.min) issues.push({ path, message: rules.message ?? `must be at least ${rules.min} characters` });
    else if (rules.max !== undefined && input.length > rules.max) issues.push({ path, message: rules.message ?? `must be at most ${rules.max} characters` });
    else if (rules.pattern !== undefined && !rules.pattern.test(input)) issues.push({ path, message: rules.message ?? "has an invalid format" });
    else if (test !== null && !test(input)) issues.push({ path, message: rules.message ?? `must be ${what}` });
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
      issues.push({ path, message: `expected ${integer ? "integer" : "number"}, got ${describe(input)}` });
      return input;
    }
    if (integer && !Number.isInteger(value)) issues.push({ path, message: "must be an integer" });
    else if (rules.min !== undefined && value < rules.min) issues.push({ path, message: `must be at least ${rules.min}` });
    else if (rules.max !== undefined && value > rules.max) issues.push({ path, message: `must be at most ${rules.max}` });
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
      if (typeof input !== "boolean") issues.push({ path, message: `expected boolean, got ${describe(input)}` });
      return input;
    });
  }
  /** One of the given string literals. */
  enum<const V extends readonly string[]>(values: V): Schema<V[number]> {
    const allowed: string[] = [];
    for (const v of values) allowed.push(v);
    return node("enum", (input, path, issues) => {
      if (typeof input !== "string" || !allowed.includes(input)) issues.push({ path, message: `must be one of: ${allowed.join(", ")}` });
      return input;
    });
  }
  array<S extends SchemaNode>(item: S, rules: { min?: number; max?: number } = {}): Schema<Infer<S>[]> {
    return node("array", (input, path, issues, coerce) => {
      if (!Array.isArray(input)) {
        issues.push({ path, message: `expected array, got ${describe(input)}` });
        return input;
      }
      if (rules.min !== undefined && input.length < rules.min) issues.push({ path, message: `must have at least ${rules.min} items` });
      if (rules.max !== undefined && input.length > rules.max) issues.push({ path, message: `must have at most ${rules.max} items` });
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
        issues.push({ path, message: `expected object, got ${describe(input)}` });
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
          if (!field.optional) issues.push({ path: at, message: "is required" });
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
    return new SchemaNode(inner.kind, (input, path, issues, coerce) => (input === undefined ? undefined : inner.check(input, path, issues, coerce)), true, inner.keys, inner.fields);
  }
  /** The value may be `null`. */
  nullable<S extends SchemaNode>(inner: S): Schema<Infer<S> | null> {
    return new SchemaNode(inner.kind, (input, path, issues, coerce) => (input === null ? null : inner.check(input, path, issues, coerce)), inner.optional, inner.keys, inner.fields);
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
