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
import { type InferModel, type Model, ModelDef } from "../../db/model";
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

  /** `this = value`; with an optional parameter the condition is skipped when it is absent. */
  eq(value: Operand<NoInfer<T>>): Expr<boolean> {
    return eq(this, value);
  }
  ne(value: Operand<NoInfer<T>>): Expr<boolean> {
    return ne(this, value);
  }
  lt(value: Operand<NoInfer<T>>): Expr<boolean> {
    return lt(this, value);
  }
  gt(value: Operand<NoInfer<T>>): Expr<boolean> {
    return gt(this, value);
  }
  lte(value: Operand<NoInfer<T>>): Expr<boolean> {
    return lte(this, value);
  }
  gte(value: Operand<NoInfer<T>>): Expr<boolean> {
    return gte(this, value);
  }
  /** `this in (...)`: an array parameter (`$.ids`) or literal values. */
  in(list: Expr<NonNullable<NoInfer<T>>[]> | readonly NonNullable<NoInfer<T>>[]): Expr<boolean> {
    return inList(this, list);
  }
  like(pattern: Operand<string>): Expr<boolean> {
    return like(this as unknown as Expr<string>, pattern);
  }
  ilike(pattern: Operand<string>): Expr<boolean> {
    return ilike(this as unknown as Expr<string>, pattern);
  }
  isNull(): Expr<boolean> {
    return isNull(this);
  }
  isNotNull(): Expr<boolean> {
    return isNotNull(this);
  }
  asc(nulls: "first" | "last" | null = null): OrderSpec {
    return asc(this, nulls);
  }
  desc(nulls: "first" | "last" | null = null): OrderSpec {
    return desc(this, nulls);
  }
}

/**
 * A parameter of `query(($) => …)` used before its type is known: `$.projectId`. Its type is taken from
 * the column (or expression) it is compared with / assigned to; `.optional()` makes every condition
 * using it disappear when it is absent; `.as("integer")` names the type where nothing else does.
 */
// biome-ignore lint/suspicious/noExplicitAny: an inferred parameter fits any operand position
export class ParamRef extends Expr<any> {
  constructor(readonly param: ParamNode) {
    super(param, param.kind, false);
  }

  /** May be left out (or null): conditions using it are skipped then. */
  optional(): ParamRef {
    this.param.optional = true;
    return this;
  }

  /** The parameter's type where no column tells it (raw SQL, select list). */
  as(kind: ValueKind, array = false): ParamRef {
    adopt(this.param, kind, array, "as()");
    return this;
  }
}

/** Gives an inferred parameter its type (from the column/expression it meets); conflicting uses fail. */
function adopt(node: Node, kind: ValueKind, array: boolean, where: string): void {
  if (!(node instanceof ParamNode) || !node.inferred) return;
  if (!node.resolved) {
    node.kind = kind;
    node.array = array;
    node.resolved = true;
    return;
  }
  if (node.kind !== kind || node.array !== array) {
    throw new Error(`Parameter $.${node.name} is used as ${node.kind}${node.array ? "[]" : ""} and as ${kind}${array ? "[]" : ""} (${where})`);
  }
}

/** Both sides of a comparison inform each other's inferred parameter type. */
function adoptPair(left: Node, leftKind: ValueKind, right: Node, rightKind: ValueKind): void {
  if (left instanceof ParamNode && left.inferred && !(right instanceof ParamNode && right.inferred && !right.resolved)) adopt(left, rightKind, false, "comparison");
  if (right instanceof ParamNode && right.inferred && !(left instanceof ParamNode && left.inferred && !left.resolved)) adopt(right, leftKind, false, "comparison");
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
  return <T>(left: Expr<T>, right: Operand<NoInfer<T>>): Expr<boolean> => {
    const r = toNode(right);
    adoptPair(left.node, left.kind, r, right instanceof Expr ? right.kind : literalKind(right));
    return bool(new BinaryNode(op, left.node, r));
  };
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
    adopt(list.node, left.kind, true, "in()");
    if (!(list.node instanceof ParamNode) || !list.node.array) throw new Error("inList: pass an array parameter (param.array(...)) or literal values");
    return bool(new InNode(left.node, list.node));
  }
  const values: LiteralNode[] = [];
  for (const v of list) values.push(new LiteralNode(v as string | number | boolean));
  return bool(new InNode(left.node, values));
}

export function like(left: Expr<string> | Expr<string | null>, pattern: Operand<string>): Expr<boolean> {
  const p = toNode(pattern);
  adopt(p, "text", false, "like()");
  return bool(new LikeNode(left.node, p, false));
}

export function ilike(left: Expr<string> | Expr<string | null>, pattern: Operand<string>): Expr<boolean> {
  const p = toNode(pattern);
  adopt(p, "text", false, "ilike()");
  return bool(new LikeNode(left.node, p, true));
}

/** `coalesce(e, fallback)`: never NULL, so typed without `| null` (no `notNull(...)` needed). */
export function coalesce<T>(e: Expr<T>, fallback: Operand<NonNullable<NoInfer<T>>>): Expr<NonNullable<T>> {
  const f = toNode(fallback);
  adopt(f, e.kind, false, "coalesce()");
  return new Expr<NonNullable<T>>(new RawNode("coalesce({0}, {1})", [e.node, f], e.kind), e.kind, false);
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
 *
 * Postgres may return NULL for any expression, so the result is typed `T | null` and decoded that way.
 * Wrap it in `notNull(...)` when the SQL cannot produce NULL (`coalesce(...)`, `count(...)`, `exists(...)`).
 */
export function sql<T>(kind: ValueKind, fragment: string, ...args: unknown[]): Expr<T | null> {
  const nodes: Node[] = [];
  for (const a of args) nodes.push(toNode(a));
  return new Expr<T | null>(new RawNode(fragment, nodes, kind), kind, true);
}

/**
 * Declares that an expression is never NULL: its type loses `| null` and the generated decoder reads it
 * as a plain value. Only for expressions that really cannot be NULL (e.g. `coalesce(x, 0)`); a NULL would
 * decode as 0 / false / "".
 */
export function notNull<T>(e: Expr<T>): Expr<NonNullable<T>> {
  return new Expr<NonNullable<T>>(e.node, e.kind, false);
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

/** A model passed directly (`from(Task)`): its table name is the alias and callbacks get its columns. */
function isModel(value: unknown): value is AnyModel {
  return value instanceof ModelDef;
}

function sourceOf(sources: Record<string, AnyModel> | AnyModel): Source {
  if (isModel(sources)) return { alias: sources.table, model: sources };
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
    /** Set for `from(Task)`: callbacks get that source's columns directly (`(t) => t.title`). */
    private readonly flat: string | null = null,
  ) {}

  private next(ast: SelectAst, cols = this.cols): SelectBuilder<R> {
    return new SelectBuilder<R>(ast, cols, this.flat);
  }

  private row(): R {
    return (this.flat === null ? this.cols : this.cols[this.flat]) as R;
  }

  join<S extends Record<string, AnyModel>>(sources: S, on: (r: R & SourceCols<S>) => Expr<boolean>): SelectBuilder<R & SourceCols<S>> {
    return this.addJoin("inner", sources, on as (r: unknown) => Expr<boolean>, false) as unknown as SelectBuilder<R & SourceCols<S>>;
  }

  /** LEFT JOIN: the joined columns become nullable. */
  leftJoin<S extends Record<string, AnyModel>>(sources: S, on: (r: R & SourceCols<S>) => Expr<boolean>): SelectBuilder<R & NullSourceCols<S>> {
    return this.addJoin("left", sources, on as (r: unknown) => Expr<boolean>, true) as unknown as SelectBuilder<R & NullSourceCols<S>>;
  }

  private addJoin(kind: "inner" | "left", sources: Record<string, AnyModel>, on: (r: unknown) => Expr<boolean>, nullable: boolean): SelectBuilder<unknown> {
    if (this.flat !== null) throw new Error("Joins need named sources: from({ t: Task }).join({ p: Project }, …)");
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
    adopt(ast.limit, "integer", false, "limit()");
    return this.next(ast);
  }

  offset(n: number | Expr<number>): SelectBuilder<R> {
    const ast = this.ast.clone();
    ast.offset = toNode(n);
    adopt(ast.offset, "integer", false, "offset()");
    return this.next(ast);
  }

  distinct(): SelectBuilder<R> {
    const ast = this.ast.clone();
    ast.distinct = true;
    return this.next(ast);
  }

  /** Whole rows of `from(Task)` (every column), without spelling out a selection. */
  rows(): Selected<RowsOf<R>> {
    if (this.flat === null) throw new Error("rows() needs from(Model); with named sources use select((r) => r.t)");
    const ast = this.ast.clone();
    ast.fields = fieldsOf(this.cols[this.flat]!);
    return new Selected<RowsOf<R>>(ast, "many");
  }

  /** The first whole row of `from(Task)`, or null. */
  first(): First<RowsOf<R>> {
    return this.rows().first();
  }

  /** Picks the result shape: `select((r) => ({ id: r.t.id, project: r.p.name }))`, or `select((r) => r.t)` for whole rows. */
  select<Sel extends Selection>(fn: (r: R) => Sel): Selected<RowOf<Sel>> {
    const ast = this.ast.clone();
    ast.fields = fieldsOf(fn(this.row()));
    return new Selected<RowOf<Sel>>(ast, "many");
  }
}

/** The row type of a single-model builder's columns. */
type RowsOf<R> = R extends Cols<infer Row> ? Row : never;

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

/**
 * `from(Task)`: callbacks get the table's columns (`(t) => t.title`). With joins, name the sources:
 * `from({ t: Task }).join({ p: Project }, (r) => r.p.id.eq(r.t.projectId))` and use `r.t.title`.
 */
export function from<M extends AnyModel>(model: M): SelectBuilder<Cols<InferModel<M>>>;
export function from<S extends Record<string, AnyModel>>(sources: S): SelectBuilder<SourceCols<S>>;
// biome-ignore lint/suspicious/noExplicitAny: implementation signature of the overloads above
export function from(sources: Record<string, AnyModel> | AnyModel): SelectBuilder<any> {
  const source = sourceOf(sources);
  return new SelectBuilder<unknown>(new SelectAst(source), { [source.alias]: columnsOf(source, false) }, isModel(sources) ? source.alias : null);
}

type RelationOptions<C, Out> = {
  /** The child's column that references the parent, e.g. `(c) => c.taskId` (or `c.c.taskId` with named sources). */
  key: (r: C) => AnyExpr;
  /** The parent's value it equals, e.g. `t.id`. */
  parent: AnyExpr;
  /** Filters, order and selection of the children (default: every column). */
  query?: (q: SelectBuilder<C>) => Selected<Out>;
};

// biome-ignore lint/suspicious/noExplicitAny: shared by the typed overloads of many/one
function relation<Out>(cardinality: "many" | "one", sources: Record<string, AnyModel> | AnyModel, options: RelationOptions<any, Out>): RelationAst {
  const source = sourceOf(sources);
  const own = columnsOf(source, false);
  const cols: unknown = isModel(sources) ? own : { [source.alias]: own };
  // biome-ignore lint/suspicious/noExplicitAny: the source shape differs per overload
  const base: SelectBuilder<any> = from(sources as AnyModel);
  const selected = options.query === undefined ? base.select(() => own as unknown as Selection) : options.query(base);
  const child = selected.ast;
  if (child.limit !== null || child.offset !== null) throw new Error("Relations cannot have limit/offset (they apply to all parents at once); filter instead");
  const key = options.key(cols);
  adopt(options.parent.node, key.kind, false, "relation parent");
  return new RelationAst(cardinality, child, key.node, options.parent.node);
}

/** The parent's children as an array: `comments: many(Comment, { key: (c) => c.taskId, parent: t.id })`. */
export function many<M extends AnyModel, Out = InferModel<M>>(model: M, options: RelationOptions<Cols<InferModel<M>>, Out>): RelationSpec<Out[]>;
export function many<S extends Record<string, AnyModel>, Out = InferModel<S[keyof S]>>(sources: S, options: RelationOptions<SourceCols<S>, Out>): RelationSpec<Out[]>;
// biome-ignore lint/suspicious/noExplicitAny: implementation signature of the overloads above
export function many(sources: Record<string, AnyModel> | AnyModel, options: RelationOptions<any, any>): RelationSpec<any> {
  return new RelationSpec<unknown[]>(relation("many", sources, options));
}

/** At most one related row, or null: `project: one(Project, { key: (p) => p.id, parent: t.projectId })`. */
export function one<M extends AnyModel, Out = InferModel<M>>(model: M, options: RelationOptions<Cols<InferModel<M>>, Out>): RelationSpec<Out | null>;
export function one<S extends Record<string, AnyModel>, Out = InferModel<S[keyof S]>>(sources: S, options: RelationOptions<SourceCols<S>, Out>): RelationSpec<Out | null>;
// biome-ignore lint/suspicious/noExplicitAny: implementation signature of the overloads above
export function one(sources: Record<string, AnyModel> | AnyModel, options: RelationOptions<any, any>): RelationSpec<any> {
  return new RelationSpec<unknown>(relation("one", sources, options));
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
    const kind = kindOfField(model.kinds[i]!);
    const node = toNode(v);
    adopt(node, kind, false, `${model.table}.${field}`);
    out.push({ column: model.columns[i]!, field, value: node, kind });
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
    private readonly flat: boolean = false,
  ) {
    super(kind === "update" ? new UpdateAst(source, set, conds, []) : new DeleteAst(source, conds, []), "affected");
  }

  private cols(): R {
    const own = columnsOf(this.source, false);
    return (this.flat ? own : { [this.source.alias]: own }) as R;
  }

  where(fn: (r: R) => Condition): WriteBuilder<S, R> {
    const c = fn(this.cols());
    const conds = [...this.conds];
    if (c !== undefined && c !== false) conds.push(c.node);
    return new WriteBuilder<S, R>(this.kind, this.source, this.set, conds, this.flat);
  }

  returning<Sel extends Record<string, AnyExpr>>(fn: (r: R) => Sel): Mutation<RowOf<Sel>[]> {
    const fields = fieldsOf(fn(this.cols()));
    const ast = this.kind === "update" ? new UpdateAst(this.source, this.set, this.conds, fields) : new DeleteAst(this.source, this.conds, fields);
    return new Mutation<RowOf<Sel>[]>(ast, "many");
  }
}

/** `update(Task, { done: true }).where((t) => t.id.eq($.id))` (or named: `update({ t: Task }, …)`). */
export function update<M extends AnyModel>(model: M, set: Values<InferModel<M>>): WriteBuilder<M, Cols<InferModel<M>>>;
export function update<S extends Record<string, AnyModel>>(sources: S, set: Values<InferModel<S[keyof S]>>): WriteBuilder<S, SourceCols<S>>;
export function update(sources: Record<string, AnyModel> | AnyModel, set: Record<string, unknown>): WriteBuilder<unknown, unknown> {
  const source = sourceOf(sources);
  return new WriteBuilder<unknown, unknown>("update", source, assignments(source.model, set), [], isModel(sources));
}

/** `deleteFrom(Task).where((t) => t.id.eq($.id))`. */
export function deleteFrom<M extends AnyModel>(model: M): WriteBuilder<M, Cols<InferModel<M>>>;
export function deleteFrom<S extends Record<string, AnyModel>>(sources: S): WriteBuilder<S, SourceCols<S>>;
export function deleteFrom(sources: Record<string, AnyModel> | AnyModel): WriteBuilder<unknown, unknown> {
  return new WriteBuilder<unknown, unknown>("delete", sourceOf(sources), [], [], isModel(sources));
}

// ---------------------------------------------------------------- definitions

type Built = Selected<any> | First<any> | Mutation<any>;
type ResultOfBuilt<B> = B extends First<infer Row> ? Row | null : B extends Selected<infer Row> ? Row[] : B extends Mutation<infer Out> ? Out : never;
/** What a `query(...)` callback may return: also a bare `from(Task)…` (its whole rows). */
// biome-ignore lint/suspicious/noExplicitAny: any builder
type Buildable = Built | SelectBuilder<any>;
type ResultOfBuildable<B> = B extends SelectBuilder<infer R> ? RowsOf<R>[] : ResultOfBuilt<B>;

function toBuilt(b: Buildable): Built {
  return b instanceof SelectBuilder ? b.rows() : b;
}

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
    /** For `query(($) => …)`: the parameters used through `$`, typed by where they were used. */
    readonly inferred: ParamNode[] | null = null,
  ) {}

  /** The query's AST, built on first use (so declaration errors surface when compiling, with its name). */
  get built(): Built {
    if (this.cached === null) {
      this.cached = this.build();
      if (this.inferred !== null) {
        for (const p of this.inferred) {
          if (!p.resolved) throw new Error(`Cannot infer the type of $.${p.name}: compare it with a column, assign it to one, or write $.${p.name}.as("integer")`);
        }
      }
    }
    return this.cached;
  }
}

/** The parameters of a `query(($) => …)`: the generated file spells out their exact types. */
export type InferredParams = { readonly __inferred: true };

/**
 * `$` in `query(($) => …)`: any property is a parameter (a `ParamRef`), typed by the column it meets.
 * Typed loosely on purpose: an index signature would read as `ParamRef | undefined` under
 * `noUncheckedIndexedAccess`. The exact parameter types are written into `.qala/queries.gen.ts`.
 */
// biome-ignore lint/suspicious/noExplicitAny: every property name is a parameter
export type Params$ = any;

/**
 * Declares a compiled query; parameters are whatever you use on `$`, typed by the columns they meet:
 *
 *   export const boardTasks = query(($) =>
 *     from(Task).where((t) => and(t.projectId.eq($.projectId), t.status.eq($.status.optional()))).orderBy((t) => [t.position]));
 *
 * `qala generate` writes the exact parameter type (`{ projectId: string; status?: string | null }`)
 * into `.qala/queries.gen.ts`, so callers of `run(db, Queries.boardTasks, …)` are fully typed.
 */
export function query<B extends Buildable>(build: ($: Params$) => B): QueryDef<InferredParams, ResultOfBuildable<B>> {
  const used: ParamNode[] = [];
  const refs = new Map<string, ParamRef>();
  const $ = new Proxy({} as Params$, {
    get(_target, name): ParamRef {
      if (typeof name !== "string") throw new Error("Query parameters are named with strings");
      let ref = refs.get(name);
      if (ref === undefined) {
        const node = new ParamNode(name, "text", false, false, true, false);
        used.push(node);
        ref = new ParamRef(node);
        refs.set(name, ref);
      }
      return ref;
    },
  });
  return new QueryDef<InferredParams, ResultOfBuildable<B>>({}, () => toBuilt(build($)), used);
}

/** The parameters of a declared query. */
export type QueryParams<D> = D extends QueryDef<infer P, infer _R> ? P : never;
/** The result of a declared query (`Row[]`, `Row | null` or a count). */
export type QueryResult<D> = D extends QueryDef<infer _P, infer R> ? R : never;
/** One row of a declared query's result. */
export type QueryRow<D> = QueryResult<D> extends (infer Row)[] ? Row : NonNullable<QueryResult<D>>;

export function defineQuery<S extends ParamShape, B extends Buildable>(definition: { params: S; query: (p: ParamExprs<S>) => B }): QueryDef<ParamsOf<S>, ResultOfBuildable<B>>;
export function defineQuery<B extends Buildable>(definition: { query: () => B }): QueryDef<Record<string, never>, ResultOfBuildable<B>>;
// biome-ignore lint/suspicious/noExplicitAny: implementation signature
export function defineQuery(definition: { params?: ParamShape; query: (p: any) => Buildable }): QueryDef<any, any> {
  const specs = definition.params ?? {};
  const exprs: Record<string, AnyExpr> = {};
  for (const name of Object.keys(specs)) {
    const s = specs[name]!;
    exprs[name] = new Expr<unknown>(new ParamNode(name, s.kind, s.array, s.optional), s.kind, s.optional);
  }
  return new QueryDef<unknown, unknown>(specs, () => toBuilt(definition.query(exprs)));
}

export { type ValueKind } from "./ast";
export { compileQuery, type Plan, type PlanLevel, type PlanParam, type PlanStatement } from "./compile";
export { emitQueries, type EmitEntry } from "./emit";
