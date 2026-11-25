import { Database, type Table } from "../db/database";
import type { Model, ModelDef } from "../db/model";
import { ValidationError } from "../errors";
import { t, type Issue, type SchemaNode, type Shape } from "../schema";
import { ActionDef, toReply, type Action, type RuntimeInput } from "./action";
import { ControllerDef, ResourceMeta, type Controller } from "./controller";
import { Reply } from "./reply";
import { authorize, type Policy } from "./policy";

/** The conventional actions a resource serves. */
export type ResourceAction = "index" | "show" | "store" | "update" | "destroy";

const ALL_ACTIONS: ResourceAction[] = ["index", "show", "store", "update", "destroy"];

export type ResourceOptions<Key extends string = string> = {
  /**
   * Nest the resource under a parent: `"projects/:projectId"` serves `/projects/:projectId/labels`. Each `:param`
   * names a model field: lists are filtered by it, new rows get it, and rows of another parent are 404.
   */
  scope?: string;
  /** Decides who may do what (`index/show/store/update/destroy`); refusals are 403. Pass an instance. */
  policy?: Policy;
  /** Serve only these actions. */
  only?: readonly ResourceAction[];
  /** Serve all actions except these. */
  except?: readonly ResourceAction[];
  /** Require a signed-in user (the app's `authenticate`) for every action. */
  auth?: true;
  /** Name used in messages such as "Label not found" (default: from the table name, singular). */
  name?: string;
  /** Fields `index` may filter on by equality: `?done=false&priority=2`. */
  filters?: readonly Key[];
  /** Order of `index` when the request has no `sort` (default: primary key ascending). */
  defaultOrder?: readonly [Key, "asc" | "desc"];
  /** Rows per page of `index` (default 20); `?pageSize=` may ask for up to `maxPageSize` (default 100). */
  pageSize?: number;
  maxPageSize?: number;
};

/** What `index` returns: one page of rows and where it is. */
export type Page<Row> = { data: Row[]; meta: { page: number; pageSize: number; total: number; pages: number } };

/** What a resource's extra actions are built from. */
export type ResourceBase<Row, Key extends string> = { db: Database; table: Table<Row, Key> };

type Selected<O> = O extends { only: readonly (infer A)[] } ? A & ResourceAction : O extends { except: readonly (infer E)[] } ? Exclude<ResourceAction, E> : ResourceAction;
type ScopeParams<S> = S extends `${string}:${infer P}/${infer Rest}` ? { [K in P]: string } & ScopeParams<Rest> : S extends `${string}:${infer P}` ? { [K in P]: string } : {};
type ScopeOf<O> = O extends { scope: infer S extends string } ? ScopeParams<S> : {};
type FilterQuery<Row, O> = O extends { filters: readonly (infer F)[] } ? { [K in F & keyof Row]?: Row[K] } : {};
type IndexQuery<Row, O> = { page?: number; pageSize?: number; sort?: string } & FilterQuery<Row, O>;

/** The typed actions of a resource (read by the typed client). */
export type ResourceActions<Row, Create, Update, O> = Pick<
  {
    index: Action<ScopeOf<O>, IndexQuery<Row, O>, undefined, Promise<Page<Row>>>;
    show: Action<ScopeOf<O> & { id: string }, Record<string, string>, undefined, Promise<Row | null>>;
    store: Action<ScopeOf<O>, Record<string, string>, Create, Promise<Row>>;
    update: Action<ScopeOf<O> & { id: string }, Record<string, string>, Update, Promise<Row | null>>;
    destroy: Action<ScopeOf<O> & { id: string }, Record<string, string>, undefined, Promise<undefined | null>>;
  },
  Selected<O>
>;

/** `:projectId` names in a scope string. */
export function scopeParams(scope: string | undefined): string[] {
  if (scope === undefined) return [];
  const out: string[] = [];
  for (const part of scope.split("/")) if (part.startsWith(":")) out.push(part.slice(1));
  return out;
}

function fieldOf(model: ModelDef, key: string): SchemaNode {
  const i = model.indexOf(key);
  if (i === -1) throw new Error(`resource(${model.table}): "${key}" is not a field of the model (fields: ${model.keys.join(", ")}); fix the option that names it in the resource() call`);
  return model.fields[i]!;
}

/** An object schema without some of its fields. */
function withoutKeys(schema: SchemaNode, drop: string[]): SchemaNode {
  if (drop.length === 0) return schema;
  const shape: Shape = {};
  for (let i = 0; i < schema.keys.length; i++) {
    const key = schema.keys[i]!;
    if (!drop.includes(key)) shape[key] = schema.fields[i]!;
  }
  return t.object(shape);
}

function coerce(field: SchemaNode, value: string, key: string, issues: Issue[]): unknown {
  return field.check(value, key, issues, true);
}

/**
 * A full CRUD controller for a model, validated by the model itself:
 *
 *   export const LabelsController = resource(Label, { scope: "projects/:projectId", policy: new LabelPolicy(), filters: ["color"] });
 *
 * index (paginated, filterable, sortable) · show · store (201) · update · destroy (204); 404 for missing rows.
 * Add custom actions with a third argument: `resource(Label, {}, ({ table }) => ({ archive: post("/:id/archive", …) }))`.
 */
export function resource<Row, Key extends string, Create, Update, const O extends ResourceOptions<Key> = {}, X extends Record<string, ActionDef> = {}>(
  model: Model<Row, Key, Create, Update>,
  options?: O,
  extra?: (base: ResourceBase<Row, Key>) => X,
): Controller<ResourceActions<Row, Create, Update, O> & X> {
  const opts: ResourceOptions<Key> = options ?? {};
  const def: ModelDef = model;
  const scope = scopeParams(opts.scope);
  for (const key of scope) fieldOf(def, key);
  for (const key of opts.filters ?? []) fieldOf(def, key);
  const actions = (opts.only ?? ALL_ACTIONS).filter((a) => !(opts.except ?? []).includes(a));
  const pageSize = opts.pageSize ?? 20;
  const maxPageSize = opts.maxPageSize ?? 100;
  const order: [string, string] = opts.defaultOrder === undefined ? [def.primaryKey, "asc"] : [opts.defaultOrder[0], opts.defaultOrder[1]];
  const policy = opts.policy ?? null;

  // Route parameters: the scope's fields and, for single rows, the primary key; validated by their model fields.
  const scopeShape: Shape = {};
  for (const key of scope) scopeShape[key] = fieldOf(def, key);
  const rowShape: Shape = { ...scopeShape, id: fieldOf(def, def.primaryKey) };
  const scopeSchema = scope.length === 0 ? null : t.object(scopeShape);
  const rowSchema = t.object(rowShape);
  // Scope fields come from the URL, never from the body.
  const storeSchema = withoutKeys(def.createSchema, scope);
  const updateSchema = withoutKeys(def.updateSchema, scope);

  const build = (deps: Record<string, unknown>): Record<string, ActionDef> => {
    const db = deps["db"] as Database;
    const table: Table<Row, Key> = db.table(model);
    const scopeWhere = (input: RuntimeInput): Record<string, unknown> => {
      const params = input.params as Record<string, unknown>;
      const where: Record<string, unknown> = {};
      for (const key of scope) where[key] = params[key];
      return where;
    };
    /** The row, or null when it does not exist or belongs to another parent. */
    const load = async (input: RuntimeInput): Promise<Row | null> => {
      const params = input.params as Record<string, unknown>;
      const row = await table.find(params["id"] as string | number);
      if (row === null) return null;
      const values = row as unknown as Record<string, unknown>;
      for (const key of scope) if (values[key] !== params[key]) return null;
      return row;
    };

    const index = async (input: RuntimeInput): Promise<Page<Row>> => {
      if (policy !== null) await authorize(policy, "index", input.user);
      const query = input.query as Record<string, string>;
      const issues: Issue[] = [];
      const where = scopeWhere(input);
      for (const key of opts.filters ?? []) {
        const raw = query[key];
        if (raw !== undefined) where[key] = coerce(fieldOf(def, key), raw, key, issues);
      }
      const page = query["page"] === undefined ? 1 : Number(query["page"]);
      const size = query["pageSize"] === undefined ? pageSize : Number(query["pageSize"]);
      if (!Number.isInteger(page) || page < 1) issues.push({ path: "page", message: "must be a positive integer", code: "min", params: { min: "1" } });
      if (!Number.isInteger(size) || size < 1 || size > maxPageSize) issues.push({ path: "pageSize", message: `must be between 1 and ${maxPageSize}`, code: "max", params: { max: String(maxPageSize) } });
      let sortKey = order[0];
      let sortDir = order[1];
      const sort = query["sort"];
      if (sort !== undefined) {
        sortKey = sort.startsWith("-") ? sort.slice(1) : sort;
        sortDir = sort.startsWith("-") ? "desc" : "asc";
        if (def.indexOf(sortKey) === -1) issues.push({ path: "sort", message: `must be a field (${def.keys.join(", ")}), optionally prefixed with -`, code: "one_of", params: { values: def.keys.join(", ") } });
      }
      if (issues.length > 0) throw new ValidationError(issues, "query");
      const [data, total] = await Promise.all([
        table.allRecords(where, [sortKey, sortDir === "desc" ? "desc" : "asc"], size, (page - 1) * size),
        table.countRecords(where),
      ]);
      return { data, meta: { page, pageSize: size, total, pages: Math.ceil(total / size) } };
    };

    const show = async (input: RuntimeInput): Promise<Row | null> => {
      const row = await load(input);
      if (row !== null && policy !== null) await authorize(policy, "show", input.user, row);
      return row;
    };

    const store = async (input: RuntimeInput): Promise<Row> => {
      const data = { ...(input.body as Record<string, unknown>), ...scopeWhere(input) };
      if (policy !== null) await authorize(policy, "store", input.user, null, data);
      return table.insertRecord(data);
    };

    const update = async (input: RuntimeInput): Promise<Row | null> => {
      const row = await load(input);
      if (row === null) return null;
      const data: Record<string, unknown> = { ...(input.body as Record<string, unknown>) };
      for (const key of scope) delete data[key];
      if (policy !== null) await authorize(policy, "update", input.user, row, data);
      const params = input.params as Record<string, unknown>;
      return table.updateRecord(params["id"] as string | number, data);
    };

    const destroy = async (input: RuntimeInput): Promise<undefined | null> => {
      const row = await load(input);
      if (row === null) return null;
      if (policy !== null) await authorize(policy, "destroy", input.user, row);
      const params = input.params as Record<string, unknown>;
      await table.delete(params["id"] as string | number);
      return undefined;
    };

    const out: Record<string, ActionDef> = {};
    for (const name of actions) {
      if (name === "index") out[name] = new ActionDef("", "", scopeSchema, null, null, async (i) => toReply(await index(i)));
      else if (name === "show") out[name] = new ActionDef("", "", rowSchema, null, null, async (i) => toReply(await show(i)));
      else if (name === "store") out[name] = new ActionDef("", "", scopeSchema, null, storeSchema, async (i) => toReply(await store(i)));
      else if (name === "update") out[name] = new ActionDef("", "", rowSchema, null, updateSchema, async (i) => toReply(await update(i)));
      // Replies built directly: serialising `undefined | null` does not compile natively.
      else out[name] = new ActionDef("", "", rowSchema, null, null, async (i) => ((await destroy(i)) === null ? new Reply(404, "", {}, [], "missing") : new Reply(204, "", {}, [], "implicit")));
    }
    if (extra !== undefined) {
      const more = extra({ db, table });
      for (const name of Object.keys(more)) out[name] = more[name]!;
    }
    return out;
  };
  const controller = new ControllerDef(["db"], [Database], build, [], opts.auth === true);
  controller.resourceName = opts.name ?? resourceName(def.table);
  const filters: string[] = [];
  for (const key of opts.filters ?? []) filters.push(key);
  controller.resource = new ResourceMeta(def, filters, policy !== null, pageSize, maxPageSize);
  return controller as Controller<ResourceActions<Row, Create, Update, O> & X>;
}

/** `project_labels` → "Project label" (for "… not found"). */
export function resourceName(table: string): string {
  const words = table.split("_").filter((w) => w !== "");
  const last = words.length - 1;
  if (last >= 0) {
    const w = words[last]!;
    words[last] = w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.endsWith("ses") ? w.slice(0, -2) : w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
  }
  const text = words.join(" ");
  return text.length === 0 ? "Resource" : text[0]!.toUpperCase() + text.slice(1);
}
