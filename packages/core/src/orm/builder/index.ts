/**
 * The query builder: declare queries with full types over your `model()` definitions; `qala generate`
 * compiles them to SQL and typed decoders (`.qala/queries.gen.ts`). Build-time only — import it from
 * `@qala/core/query` in `app/infrastructure/queries/*.query.ts`, never from code that runs in the app.
 *
 *   export const boardTasks = defineQuery({
 *     params: { projectId: param.uuid(), done: param.optional(param.boolean()) },
 *     query: (p) =>
 *       from({ t: Task })
 *         .where((r) => and(eq(r.t.projectId, p.projectId), eq(r.t.done, p.done)))
 *         .orderBy((r) => [desc(r.t.createdAt)])
 *         .select((r) => ({ id: r.t.id, title: r.t.title, comments: many({ c: Comment }, { key: (c) => c.c.taskId, parent: r.t.id }) })),
 *   });
 */
import type { InferModel, Model, ModelDef } from "../../db/model";
import {
  AggregateNode,
  type AggregateFn,
  type Assignment,
  BinaryNode,
  ColumnNode,
  type ComparisonOp,
  DeleteAst,
  ExistsNode,
  type Field,
  InNode,
  InsertAst,
  kindOfField,
  LikeNode,
  LiteralNode,
  LogicalNode,
  type Node,
  NotNode,
  NullTestNode,
  type Order,
  ParamNode,
  RawNode,
  RelationAst,
  type ResultMode,
  SelectAst,
  type Source,
  UpdateAst,
  type ValueKind,
} from "./ast";

// ---------------------------------------------------------------- expressions

/** A typed SQL expression. `T` is the value type it produces (`| null` when it can be NULL). */
export class Expr<T> {
  declare readonly __t: (x: T) => T;
  constructor(
    readonly node: Node,
    readonly kind: ValueKind,
    readonly nullable: boolean,
  ) {}
}

// biome-ignore lint/suspicious/noExplicitAny: "any expression" (Expr is invariant in T)
export type AnyExpr = Expr<any>;

/** A value of a column type, or an expression producing it. */
export type Operand<T> = Expr<T> | Expr<NonNullable<T>> | Expr<T | null> | NonNullable<T>;

function literalKind(value: unknown): ValueKind {
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  return "text";
}

function toNode(value: unknown): Node {
  if (value instanceof Expr) return value.node;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return new LiteralNode(value);
  throw new Error(`Unsupported value in a query: ${String(value)}`);
}

function bool(node: Node): Expr<boolean> {
  return new Expr<boolean>(node, "boolean", false);
}

function compare(op: ComparisonOp) {
  return <T>(left: Expr<T>, right: Operand<NoInfer<T>>): Expr<boolean> => bool(new BinaryNode(op, left.node, toNode(right)));
}

/** `a = b`. With an optional parameter, the condition is skipped when the parameter is null/absent. */
export const eq = compare("=");
export const ne = compare("<>");
export const lt = compare("<");
export const gt = compare(">");
export const lte = compare("<=");
export const gte = compare(">=");

/** `a in (...)`: an array parameter (`param.array(...)`) or literal values. */
export function inList<T>(left: Expr<T>, list: Expr<NonNullable<NoInfer<T>>[]> | readonly NonNullable<NoInfer<T>>[]): Expr<boolean> {
  if (list instanceof Expr) {
    if (!(list.node instanceof ParamNode) || !list.node.array) throw new Error("inList: pass an array parameter (param.array(...)) or literal values");
    return bool(new InNode(left.node, list.node));
  }
  const values: LiteralNode[] = [];
  for (const v of list) values.push(new LiteralNode(v as string | number | boolean));
  return bool(new InNode(left.node, values));
}

export function like(left: Expr<string> | Expr<string | null>, pattern: Operand<string>): Expr<boolean> {
  return bool(new LikeNode(left.node, toNode(pattern), false));
}

export function ilike(left: Expr<string> | Expr<string | null>, pattern: Operand<string>): Expr<boolean> {
  return bool(new LikeNode(left.node, toNode(pattern), true));
}

export function isNull<T>(e: Expr<T>): Expr<boolean> {
  return bool(new NullTestNode(e.node, false));
}

export function isNotNull<T>(e: Expr<T>): Expr<boolean> {
  return bool(new NullTestNode(e.node, true));
}

type Condition = Expr<boolean> | Expr<boolean | null> | undefined | false;

function conditions(items: Condition[]): Node[] {
  const out: Node[] = [];
  for (const c of items) if (c !== undefined && c !== false) out.push(c.node);
  return out;
}

/** All conditions hold (`undefined`/`false` entries are ignored, handy for static composition). */
export function and(...items: Condition[]): Expr<boolean> {
  return bool(new LogicalNode("and", conditions(items)));
}

export function or(...items: Condition[]): Expr<boolean> {
  return bool(new LogicalNode("or", conditions(items)));
}

export function not(e: Expr<boolean> | Expr<boolean | null>): Expr<boolean> {
  return bool(new NotNode(e.node));
}

/** `exists (subquery)`; the subquery may refer to the outer query's aliases. */
export function exists(query: SelectBuilder<any> | Selected<any>): Expr<boolean> {
  return bool(new ExistsNode(query.ast, false));
}

export function notExists(query: SelectBuilder<any> | Selected<any>): Expr<boolean> {
  return bool(new ExistsNode(query.ast, true));
}

function aggregate<T>(fn: AggregateFn, e: AnyExpr | null, kind: ValueKind, nullable: boolean, distinct = false): Expr<T> {
  return new Expr<T>(new AggregateNode(fn, e === null ? null : e.node, kind, distinct), kind, nullable);
}

/** `count(*)`, or `count(expr)` (non-null values). */
export function count(e?: AnyExpr): Expr<number> {
  return aggregate<number>("count", e ?? null, "bigint", false);
}

export function countDistinct(e: AnyExpr): Expr<number> {
  return aggregate<number>("count", e, "bigint", false, true);
}

/** `sum(expr)`; null when there are no rows. */
export function sum(e: Expr<number> | Expr<number | null>): Expr<number | null> {
  return aggregate<number | null>("sum", e, "number", true);
}

export function avg(e: Expr<number> | Expr<number | null>): Expr<number | null> {
  return aggregate<number | null>("avg", e, "number", true);
}

export function min<T>(e: Expr<T>): Expr<T | null> {
  return aggregate<T | null>("min", e, e.kind, true);
}

export function max<T>(e: Expr<T>): Expr<T | null> {
  return aggregate<T | null>("max", e, e.kind, true);
}

/**
 * A raw SQL expression: `sql<number>("integer", "extract(day from {0})", r.t.dueAt)`. `{n}` holes take
 * expressions or values (always as parameters/literals, never spliced text).
 */
export function sql<T>(kind: ValueKind, fragment: string, ...args: unknown[]): Expr<T> {
  const nodes: Node[] = [];
  for (const a of args) nodes.push(toNode(a));
  return new Expr<T>(new RawNode(fragment, nodes, kind), kind, true);
}

// ---------------------------------------------------------------- parameters

/** A declared parameter: `T` its value type; `Opt` whether callers may leave it out. */
export class ParamSpec<T, Opt extends boolean> {
  declare readonly __t: (x: T) => T;
  declare readonly __opt: Opt;
  constructor(
    readonly kind: ValueKind,
    readonly array: boolean,
    readonly optional: boolean,
  ) {}
}

export const param = {
  uuid: (): ParamSpec<string, false> => new ParamSpec<string, false>("uuid", false, false),
  text: (): ParamSpec<string, false> => new ParamSpec<string, false>("text", false, false),
  int: (): ParamSpec<number, false> => new ParamSpec<number, false>("integer", false, false),
  bigint: (): ParamSpec<number, false> => new ParamSpec<number, false>("bigint", false, false),
  number: (): ParamSpec<number, false> => new ParamSpec<number, false>("number", false, false),
  boolean: (): ParamSpec<boolean, false> => new ParamSpec<boolean, false>("boolean", false, false),
  /** One of the given strings (for enum columns). */
  enum: <const V extends readonly string[]>(_values: V): ParamSpec<V[number], false> => new ParamSpec<V[number], false>("text", false, false),
  /** An ISO-8601 timestamp string. */
  datetime: (): ParamSpec<string, false> => new ParamSpec<string, false>("datetime", false, false),
  array: <T>(item: ParamSpec<T, false>): ParamSpec<T[], false> => new ParamSpec<T[], false>(item.kind, true, false),
  /** May be omitted or null; every condition using it is skipped then (it compiles to `($n is null or …)`). */
  optional: <T>(inner: ParamSpec<T, false>): ParamSpec<T, true> => new ParamSpec<T, true>(inner.kind, inner.array, true),
};

// biome-ignore lint/suspicious/noExplicitAny: any parameter spec (ParamSpec is invariant)
type ParamShape = Record<string, ParamSpec<any, boolean>>;
type ValueOf<S> = S extends ParamSpec<infer T, boolean> ? T : never;
// biome-ignore lint/suspicious/noExplicitAny: any value type
type OptionalNames<S extends ParamShape> = { [K in keyof S]: S[K] extends ParamSpec<any, true> ? K : never }[keyof S];
type Simplify<T> = { [K in keyof T]: T[K] } & {};
/** The parameters object callers pass. */
export type ParamsOf<S extends ParamShape> = Simplify<{ [K in Exclude<keyof S, OptionalNames<S>>]: ValueOf<S[K]> } & { [K in OptionalNames<S>]?: ValueOf<S[K]> | null }>;
/** The parameter expressions a query declaration receives. */
export type ParamExprs<S extends ParamShape> = { [K in keyof S]: Expr<ValueOf<S[K]>> };

// ---------------------------------------------------------------- sources and selections

type AnyModel = Model<object, string>;
type Cols<Row> = { readonly [K in keyof Row]-?: Expr<Row[K]> };
type NullCols<Row> = { readonly [K in keyof Row]-?: Expr<Row[K] | null> };
type SourceCols<S> = { [A in keyof S]: Cols<InferModel<S[A]>> };
type NullSourceCols<S> = { [A in keyof S]: NullCols<InferModel<S[A]>> };

function sourceOf(sources: Record<string, AnyModel>): Source {
  const aliases = Object.keys(sources);
  if (aliases.length !== 1) throw new Error("Pass exactly one source: from({ t: Task })");
  return { alias: aliases[0]!, model: sources[aliases[0]!]! };
}

/** Whether a model field accepts null (its schema validates `null`). */
function fieldNullable(model: ModelDef, index: number): boolean {
  const issues: { path: string; message: string }[] = [];
  model.fields[index]!.check(null, "", issues, false);
  return issues.length === 0;
}

function columnsOf(source: Source, forceNullable: boolean): Record<string, AnyExpr> {
  const cols: Record<string, AnyExpr> = {};
  const m = source.model;
  for (let i = 0; i < m.keys.length; i++) {
    const nullable = forceNullable || fieldNullable(m, i);
    const kind = kindOfField(m.kinds[i]!);
    cols[m.keys[i]!] = new Expr<unknown>(new ColumnNode(source.alias, m, m.keys[i]!, m.columns[i]!, kind, nullable), kind, nullable);
  }
  return cols;
}

/** A relation in a selection: loaded by its own statement, keyed by the parent, in the same round trip. */
export class RelationSpec<T> {
  declare readonly __t: (x: T) => T;
  constructor(readonly ast: RelationAst) {}
}

// biome-ignore lint/suspicious/noExplicitAny: any relation
type Selection = Record<string, AnyExpr | RelationSpec<any>>;
type RowOf<Sel> = Simplify<{ [K in keyof Sel]: Sel[K] extends Expr<infer T> ? T : Sel[K] extends RelationSpec<infer X> ? X : never }>;

function fieldsOf(selection: Selection): Field[] {
  const fields: Field[] = [];
  for (const name of Object.keys(selection)) {
    const v = selection[name]!;
    if (v instanceof RelationSpec) fields.push({ type: "relation", name, relation: v.ast });
    else if (v instanceof Expr) fields.push({ type: "value", name, expr: v.node, kind: v.kind, nullable: v.nullable });
    else throw new Error(`select: field "${name}" is not an expression or relation`);
  }
  return fields;
}

export type OrderSpec = { readonly __order: Order };
export function asc(e: AnyExpr, nulls: "first" | "last" | null = null): OrderSpec {
  return { __order: { expr: e.node, dir: "asc", nulls } };
}
export function desc(e: AnyExpr, nulls: "first" | "last" | null = null): OrderSpec {
  return { __order: { expr: e.node, dir: "desc", nulls } };
}

/** A query whose rows are not selected yet. `R` maps aliases to their columns. */
export class SelectBuilder<R> {
  declare readonly __r: (x: R) => R;
  constructor(
    readonly ast: SelectAst,
    private readonly cols: Record<string, Record<string, AnyExpr>>,
  ) {}

  private next(ast: SelectAst, cols = this.cols): SelectBuilder<R> {
    return new SelectBuilder<R>(ast, cols);
  }

  private row(): R {
    return this.cols as R;
  }

  join<S extends Record<string, AnyModel>>(sources: S, on: (r: R & SourceCols<S>) => Expr<boolean>): SelectBuilder<R & SourceCols<S>> {
    return this.addJoin("inner", sources, on as (r: unknown) => Expr<boolean>, false) as unknown as SelectBuilder<R & SourceCols<S>>;
  }

  /** LEFT JOIN: the joined columns become nullable. */
  leftJoin<S extends Record<string, AnyModel>>(sources: S, on: (r: R & SourceCols<S>) => Expr<boolean>): SelectBuilder<R & NullSourceCols<S>> {
    return this.addJoin("left", sources, on as (r: unknown) => Expr<boolean>, true) as unknown as SelectBuilder<R & NullSourceCols<S>>;
  }

  private addJoin(kind: "inner" | "left", sources: Record<string, AnyModel>, on: (r: unknown) => Expr<boolean>, nullable: boolean): SelectBuilder<unknown> {
    const source = sourceOf(sources);
    if (this.cols[source.alias] !== undefined) throw new Error(`Alias "${source.alias}" is used twice`);
    const onCols = { ...this.cols, [source.alias]: columnsOf(source, false) };
    const cond = on(onCols);
    const ast = this.ast.clone();
    ast.joins.push({ kind, source, on: cond.node });
    return new SelectBuilder<unknown>(ast, { ...this.cols, [source.alias]: columnsOf(source, nullable) });
  }

  /** Adds a condition (several calls are combined with AND). */
  where(fn: (r: R) => Condition): SelectBuilder<R> {
    const c = fn(this.row());
    const ast = this.ast.clone();
    if (c !== undefined && c !== false) ast.where.push(c.node);
    return this.next(ast);
  }

  groupBy(fn: (r: R) => AnyExpr[]): SelectBuilder<R> {
    const ast = this.ast.clone();
    for (const e of fn(this.row())) ast.groupBy.push(e.node);
    return this.next(ast);
  }

  having(fn: (r: R) => Condition): SelectBuilder<R> {
    const c = fn(this.row());
    const ast = this.ast.clone();
    if (c !== undefined && c !== false) ast.having.push(c.node);
    return this.next(ast);
  }

  /** `orderBy((r) => [desc(r.t.createdAt), r.t.id])`; a bare expression sorts ascending. */
  orderBy(fn: (r: R) => (OrderSpec | AnyExpr)[]): SelectBuilder<R> {
    const ast = this.ast.clone();
    for (const o of fn(this.row())) ast.orderBy.push(o instanceof Expr ? { expr: o.node, dir: "asc", nulls: null } : o.__order);
    return this.next(ast);
  }

  /** A number or an integer parameter (an optional parameter left out means no limit). */
  limit(n: number | Expr<number>): SelectBuilder<R> {
    const ast = this.ast.clone();
    ast.limit = toNode(n);
    return this.next(ast);
  }

  offset(n: number | Expr<number>): SelectBuilder<R> {
    const ast = this.ast.clone();
    ast.offset = toNode(n);
    return this.next(ast);
  }

  distinct(): SelectBuilder<R> {
    const ast = this.ast.clone();
    ast.distinct = true;
    return this.next(ast);
  }

  /** Picks the result shape: `select((r) => ({ id: r.t.id, project: r.p.name }))`, or `select((r) => r.t)` for whole rows. */
  select<Sel extends Selection>(fn: (r: R) => Sel): Selected<RowOf<Sel>> {
    const ast = this.ast.clone();
    ast.fields = fieldsOf(fn(this.row()));
    return new Selected<RowOf<Sel>>(ast, "many");
  }
}

/** A query with its selection: returns `Row[]`, or `Row | null` after `.first()`. */
export class Selected<Row> {
  declare readonly __row: (x: Row) => Row;
  constructor(
    readonly ast: SelectAst,
    readonly mode: ResultMode,
  ) {}

  /** Only the first row (LIMIT 1); the result is `Row | null`. */
  first(): First<Row> {
    const ast = this.ast.clone();
    ast.limit = new LiteralNode(1);
    return new First<Row>(ast, "first");
  }
}

export class First<Row> {
  declare readonly __first: (x: Row) => Row;
  constructor(
    readonly ast: SelectAst,
    readonly mode: ResultMode,
  ) {}
}

/** `from({ t: Task })`: the alias (`t`) names the table's columns in the callbacks (`r.t.title`). */
export function from<S extends Record<string, AnyModel>>(sources: S): SelectBuilder<SourceCols<S>> {
  const source = sourceOf(sources);
  return new SelectBuilder<SourceCols<S>>(new SelectAst(source), { [source.alias]: columnsOf(source, false) });
}

type RelationOptions<S, Out> = {
  /** The child's column that references the parent, e.g. `(c) => c.c.taskId`. */
  key: (r: SourceCols<S>) => AnyExpr;
  /** The parent's value it equals, e.g. `r.t.id`. */
  parent: AnyExpr;
  /** Filters, order and selection of the children (default: every column). */
  query?: (q: SelectBuilder<SourceCols<S>>) => Selected<Out>;
};

function relation<S extends Record<string, AnyModel>, Out>(cardinality: "many" | "one", sources: S, options: RelationOptions<S, Out>): RelationAst {
  const source = sourceOf(sources);
  const cols = { [source.alias]: columnsOf(source, false) } as unknown as SourceCols<S>;
  const base = from(sources);
  const selected = options.query === undefined ? base.select(() => (cols as unknown as Record<string, Selection>)[source.alias]!) : options.query(base);
  const child = selected.ast;
  if (child.limit !== null || child.offset !== null) throw new Error("Relations cannot have limit/offset (they apply to all parents at once); filter instead");
  return new RelationAst(cardinality, child, options.key(cols).node, options.parent.node);
}

/** The parent's children as an array: `comments: many({ c: Comment }, { key: (c) => c.c.taskId, parent: r.t.id })`. */
export function many<S extends Record<string, AnyModel>, Out = InferModel<S[keyof S]>>(sources: S, options: RelationOptions<S, Out>): RelationSpec<Out[]> {
  return new RelationSpec<Out[]>(relation("many", sources, options));
}

/** At most one related row, or null: `project: one({ p: Project }, { key: (p) => p.p.id, parent: r.t.projectId })`. */
export function one<S extends Record<string, AnyModel>, Out = InferModel<S[keyof S]>>(sources: S, options: RelationOptions<S, Out>): RelationSpec<Out | null> {
  return new RelationSpec<Out | null>(relation("one", sources, options));
}

// ---------------------------------------------------------------- mutations

type Values<Row> = { [K in keyof Row]?: Operand<Row[K]> };

function assignments(model: ModelDef, values: Record<string, unknown>): Assignment[] {
  const out: Assignment[] = [];
  for (const field of Object.keys(values)) {
    const v = values[field];
    if (v === undefined) continue;
    const i = model.keys.indexOf(field);
    if (i === -1) throw new Error(`${model.table}: unknown field "${field}"`);
    out.push({ column: model.columns[i]!, field, value: toNode(v), kind: kindOfField(model.kinds[i]!) });
  }
  return out;
}

/** An INSERT/UPDATE/DELETE: the affected-row count, or the `returning(...)` rows. */
export class Mutation<Out> {
  declare readonly __out: (x: Out) => Out;
  constructor(
    readonly ast: InsertAst | UpdateAst | DeleteAst,
    readonly mode: ResultMode,
  ) {}
}

class InsertBuilder<Row> extends Mutation<number> {
  constructor(
    private readonly model: ModelDef,
    private readonly alias: string,
    private readonly values: Assignment[],
    private readonly conflict: { columns: string[]; update: Assignment[] | null } | null,
  ) {
    super(new InsertAst(model, values, [], conflict), "affected");
  }

  /** `ON CONFLICT (fields) DO NOTHING`, or `DO UPDATE SET` the given values. */
  onConflict(fields: (keyof Row & string)[], update?: Values<Row>): InsertBuilder<Row> {
    const columns: string[] = [];
    for (const f of fields) columns.push(this.model.columnOf(f));
    return new InsertBuilder<Row>(this.model, this.alias, this.values, { columns, update: update === undefined ? null : assignments(this.model, update as Record<string, unknown>) });
  }

  returning<Sel extends Record<string, AnyExpr>>(fn: (r: Cols<Row>) => Sel): Mutation<RowOf<Sel>[]> {
    const cols = columnsOf({ alias: this.alias, model: this.model }, false);
    return new Mutation<RowOf<Sel>[]>(new InsertAst(this.model, this.values, fieldsOf(fn(cols as Cols<Row>)), this.conflict), "many");
  }
}

/** `insertInto(Task, { title: p.title, done: false })`. */
export function insertInto<M extends AnyModel>(model: M, values: Values<InferModel<M>>): InsertBuilder<InferModel<M>> {
  return new InsertBuilder<InferModel<M>>(model, model.table, assignments(model, values as Record<string, unknown>), null);
}

class WriteBuilder<S, R> extends Mutation<number> {
  constructor(
    private readonly kind: "update" | "delete",
    private readonly source: Source,
    private readonly set: Assignment[],
    private readonly conds: Node[],
  ) {
    super(kind === "update" ? new UpdateAst(source, set, conds, []) : new DeleteAst(source, conds, []), "affected");
  }

  private cols(): R {
    return { [this.source.alias]: columnsOf(this.source, false) } as R;
  }

  where(fn: (r: R) => Condition): WriteBuilder<S, R> {
    const c = fn(this.cols());
    const conds = [...this.conds];
    if (c !== undefined && c !== false) conds.push(c.node);
    return new WriteBuilder<S, R>(this.kind, this.source, this.set, conds);
  }

  returning<Sel extends Record<string, AnyExpr>>(fn: (r: R) => Sel): Mutation<RowOf<Sel>[]> {
    const fields = fieldsOf(fn(this.cols()));
    const ast = this.kind === "update" ? new UpdateAst(this.source, this.set, this.conds, fields) : new DeleteAst(this.source, this.conds, fields);
    return new Mutation<RowOf<Sel>[]>(ast, "many");
  }
}

/** `update({ t: Task }, { done: true }).where((r) => eq(r.t.id, p.id))`. */
export function update<S extends Record<string, AnyModel>>(sources: S, set: Values<InferModel<S[keyof S]>>): WriteBuilder<S, SourceCols<S>> {
  const source = sourceOf(sources);
  return new WriteBuilder<S, SourceCols<S>>("update", source, assignments(source.model, set as Record<string, unknown>), []);
}

/** `deleteFrom({ t: Task }).where((r) => eq(r.t.id, p.id))`. */
export function deleteFrom<S extends Record<string, AnyModel>>(sources: S): WriteBuilder<S, SourceCols<S>> {
  return new WriteBuilder<S, SourceCols<S>>("delete", sourceOf(sources), [], []);
}

// ---------------------------------------------------------------- definitions

type Built = Selected<any> | First<any> | Mutation<any>;
type ResultOfBuilt<B> = B extends First<infer Row> ? Row | null : B extends Selected<infer Row> ? Row[] : B extends Mutation<infer Out> ? Out : never;

const QUERY_BRAND = Symbol.for("qala.QueryDef");

/** Whether a module export is a declared query (works across copies of this module). */
// biome-ignore lint/suspicious/noExplicitAny: any declared query
export type AnyQueryDef = QueryDef<any, any>;

export function isQueryDef(value: unknown): value is AnyQueryDef {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[QUERY_BRAND] === true;
}

/** A declared query: compiled by `qala generate`. `P` its parameters, `Res` its result. */
export class QueryDef<P, Res> {
  declare readonly __def: (x: { params: P; result: Res }) => { params: P; result: Res };
  readonly [QUERY_BRAND] = true;
  private cached: Built | null = null;
  constructor(
    readonly params: ParamShape,
    private readonly build: () => Built,
  ) {}

  /** The query's AST, built on first use (so declaration errors surface when compiling, with its name). */
  get built(): Built {
    if (this.cached === null) this.cached = this.build();
    return this.cached;
  }
}

/** The parameters of a declared query. */
export type QueryParams<D> = D extends QueryDef<infer P, infer _R> ? P : never;
/** The result of a declared query (`Row[]`, `Row | null` or a count). */
export type QueryResult<D> = D extends QueryDef<infer _P, infer R> ? R : never;
/** One row of a declared query's result. */
export type QueryRow<D> = QueryResult<D> extends (infer Row)[] ? Row : NonNullable<QueryResult<D>>;

export function defineQuery<S extends ParamShape, B extends Built>(definition: { params: S; query: (p: ParamExprs<S>) => B }): QueryDef<ParamsOf<S>, ResultOfBuilt<B>>;
export function defineQuery<B extends Built>(definition: { query: () => B }): QueryDef<Record<string, never>, ResultOfBuilt<B>>;
// biome-ignore lint/suspicious/noExplicitAny: implementation signature
export function defineQuery(definition: { params?: ParamShape; query: (p: any) => Built }): QueryDef<any, any> {
  const specs = definition.params ?? {};
  const exprs: Record<string, AnyExpr> = {};
  for (const name of Object.keys(specs)) {
    const s = specs[name]!;
    exprs[name] = new Expr<unknown>(new ParamNode(name, s.kind, s.array, s.optional), s.kind, s.optional);
  }
  return new QueryDef<unknown, unknown>(specs, () => definition.query(exprs));
}

export { type ValueKind } from "./ast";
export { compileQuery, type Plan, type PlanLevel, type PlanParam, type PlanStatement } from "./compile";
export { emitQueries, type EmitEntry } from "./emit";
