/**
 * Compiles a declared query into a plan: the final SQL of every statement, the order of their `$n`
 * parameters and the shape of their rows. Build-time only.
 *
 * Relations (`many`/`one`) never cause N+1 queries: each relation level is its own statement that
 * selects the children whose key is in the parent's key set, expressed as a subquery over the parent's
 * own filters (`where c.task_id in (select t.id from tasks t where <parent filters> order/limit …)`).
 * Every statement therefore depends only on the query's parameters, so all levels go to PostgreSQL in
 * ONE pipelined round trip; generated code stitches the rows together by key.
 */
import type { AnyQueryDef } from "./index";
import {
  AggregateNode,
  BinaryNode,
  ColumnNode,
  DeleteAst,
  ExistsNode,
  type Field,
  InNode,
  InsertAst,
  LikeNode,
  LiteralNode,
  LogicalNode,
  type Node,
  NotNode,
  NullTestNode,
  ParamNode,
  RawNode,
  RelationAst,
  type ResultMode,
  SelectAst,
  SQL_TYPE,
  UpdateAst,
  type ValueKind,
} from "./ast";

export type PlanParam = { name: string; kind: ValueKind; array: boolean; optional: boolean };

/** A decoded value column of a level's rows. */
export type PlanValue = { type: "value"; name: string; index: number; kind: ValueKind; nullable: boolean; enumField: boolean };
/** A relation field of a level: rows of `level`, matched by this level's hidden key column `keyIndex`. */
export type PlanRelation = { type: "relation"; name: string; level: number; keyIndex: number };

export type PlanLevel = {
  /** Statement index (levels and statements are 1:1). */
  statement: number;
  cardinality: "root" | "many" | "one";
  /** For relation levels: column 0 holds the key the rows are grouped by. */
  parent: number;
  /** Fields in selection order. */
  fields: (PlanValue | PlanRelation)[];
};

export type PlanStatement = { sql: string; params: PlanParam[] };
export type Plan = {
  mode: ResultMode;
  statements: PlanStatement[];
  levels: PlanLevel[];
  /** For `query(($) => …)`: every parameter with its inferred type (the generated file spells the type out). */
  inferred: PlanParam[] | null;
};

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

function literal(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Invalid number literal ${value}`);
    return String(value);
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Parameters of one statement, numbered in order of first use.
 *
 * A parameter that is only ever compared with or assigned to a column is written bare (`$1`): Postgres
 * then gives it that column's exact type, so enum, jsonb or domain columns need no hand-written casts.
 * Anywhere else (raw SQL, `like` patterns, limit) it carries an explicit cast (`$1::int4`).
 */
class Params {
  readonly list: PlanParam[] = [];
  constructor(private readonly bare: Set<string> = new Set()) {}
  ref(p: ParamNode): string {
    let i = this.list.findIndex((x) => x.name === p.name);
    if (i === -1) {
      this.list.push({ name: p.name, kind: p.kind, array: p.array, optional: p.optional });
      i = this.list.length - 1;
    }
    if (this.bare.has(p.name)) return `$${i + 1}`;
    return `$${i + 1}::${SQL_TYPE[p.kind]}${p.array ? "[]" : ""}`;
  }
}

/** How each parameter of a statement is used: next to a column (`bound`) or anywhere else (`other`). */
class Uses {
  readonly bound = new Map<string, number>();
  readonly other = new Map<string, number>();
  private inc(map: Map<string, number>, name: string): void {
    map.set(name, (map.get(name) ?? 0) + 1);
  }
  node(n: Node | null): void {
    if (n === null) return;
    if (n instanceof ParamNode) this.inc(this.other, n.name);
    else if (n instanceof BinaryNode) {
      if (n.left instanceof ColumnNode && n.right instanceof ParamNode) this.inc(this.bound, n.right.name);
      else if (n.right instanceof ColumnNode && n.left instanceof ParamNode) this.inc(this.bound, n.left.name);
      else {
        this.node(n.left);
        this.node(n.right);
      }
    } else if (n instanceof LogicalNode) for (const i of n.items) this.node(i);
    else if (n instanceof NotNode) this.node(n.inner);
    else if (n instanceof NullTestNode) this.node(n.inner);
    else if (n instanceof InNode) {
      if (n.list instanceof ParamNode && n.inner instanceof ColumnNode) this.inc(this.bound, n.list.name);
      else {
        this.node(n.inner);
        if (n.list instanceof ParamNode) this.node(n.list);
      }
    } else if (n instanceof LikeNode) {
      this.node(n.inner);
      this.node(n.pattern);
    } else if (n instanceof ExistsNode) this.select(n.query);
    else if (n instanceof AggregateNode) this.node(n.inner);
    else if (n instanceof RawNode) for (const a of n.args) this.node(a);
  }
  select(ast: SelectAst): void {
    for (const f of ast.fields) if (f.type === "value") this.node(f.expr);
    for (const j of ast.joins) this.node(j.on);
    for (const w of ast.where) this.node(w);
    for (const g of ast.groupBy) this.node(g);
    for (const h of ast.having) this.node(h);
    for (const o of ast.orderBy) this.node(o.expr);
    this.node(ast.limit);
    this.node(ast.offset);
  }
  assigned(values: { value: Node }[]): void {
    for (const a of values) {
      if (a.value instanceof ParamNode) this.inc(this.bound, a.value.name);
      else this.node(a.value);
    }
  }
  bare(): Set<string> {
    const out = new Set<string>();
    for (const name of this.bound.keys()) if (!this.other.has(name)) out.add(name);
    return out;
  }
}

function optionalParams(node: Node, out: ParamNode[]): ParamNode[] {
  if (node instanceof ParamNode) {
    if (node.optional && !out.some((p) => p.name === node.name)) out.push(node);
  } else if (node instanceof BinaryNode) {
    optionalParams(node.left, out);
    optionalParams(node.right, out);
  } else if (node instanceof InNode) {
    optionalParams(node.inner, out);
    if (node.list instanceof ParamNode) optionalParams(node.list, out);
  } else if (node instanceof LikeNode) {
    optionalParams(node.inner, out);
    optionalParams(node.pattern, out);
  } else if (node instanceof RawNode) {
    for (const a of node.args) optionalParams(a, out);
  }
  return out;
}

/**
 * Wraps a predicate that uses optional parameters: it holds when any of them is null. The comparison
 * comes first so a bare parameter's type is inferred from its column before the `is null` test.
 */
function guarded(node: Node, sql: string, params: Params): string {
  const opt = optionalParams(node, []);
  if (opt.length === 0) return sql;
  const tests = opt.map((p) => `${params.ref(p)} is null`);
  return `(${sql} or ${tests.join(" or ")})`;
}

function expr(node: Node, params: Params): string {
  if (node instanceof ColumnNode) return `${quote(node.alias)}.${quote(node.column)}`;
  if (node instanceof ParamNode) return params.ref(node);
  if (node instanceof LiteralNode) return literal(node.value);
  if (node instanceof BinaryNode) return guarded(node, `${expr(node.left, params)} ${node.op} ${expr(node.right, params)}`, params);
  if (node instanceof LogicalNode) {
    if (node.items.length === 0) return node.op === "and" ? "true" : "false";
    if (node.items.length === 1) return expr(node.items[0]!, params);
    return `(${node.items.map((i) => expr(i, params)).join(` ${node.op} `)})`;
  }
  if (node instanceof NotNode) return `(not ${expr(node.inner, params)})`;
  if (node instanceof NullTestNode) return `(${expr(node.inner, params)} is ${node.negate ? "not " : ""}null)`;
  if (node instanceof InNode) {
    if (node.list instanceof ParamNode) return guarded(node, `${expr(node.inner, params)} = any(${params.ref(node.list)})`, params);
    if (node.list.length === 0) return "false";
    return `${expr(node.inner, params)} in (${node.list.map((l) => literal(l.value)).join(", ")})`;
  }
  if (node instanceof LikeNode) return guarded(node, `${expr(node.inner, params)} ${node.insensitive ? "ilike" : "like"} ${expr(node.pattern, params)}`, params);
  if (node instanceof ExistsNode) return `${node.negate ? "not " : ""}exists (${selectSql(node.query, params, [], null)})`;
  if (node instanceof AggregateNode) {
    const inner = node.inner === null ? "*" : `${node.distinct ? "distinct " : ""}${expr(node.inner, params)}`;
    return `${node.fn}(${inner})`;
  }
  if (node instanceof RawNode) return `(${node.sql.replace(/\{(\d+)\}/g, (_, i: string) => expr(node.args[Number(i)]!, params))})`;
  throw new Error("Unknown expression node");
}

/** A value as text in the result (so every column decodes from Postgres' text format). */
function selected(node: Node, kind: ValueKind, params: Params): string {
  const sql = expr(node, params);
  // Aggregates over integers (count/sum) come back as bigint/numeric; text is what we decode anyway.
  return kind === "datetime" && !(node instanceof ColumnNode) ? `(${sql})::timestamptz` : sql;
}

/** How a relation level is restricted: its `childKey` must be in the parent's key set. */
type KeyLink = { childKey: Node; parentAst: SelectAst; parentKey: Node; parentLink: KeyLink | null };

/**
 * SQL for a SELECT. `extra` are columns put before the selection (a relation's key); `link` restricts
 * the rows to the parent's key set (relation levels).
 */
function selectSql(ast: SelectAst, params: Params, columns: string[], link: KeyLink | null): string {
  const parts: string[] = [];
  parts.push(`select ${ast.distinct ? "distinct " : ""}${columns.length === 0 ? "1" : columns.join(", ")}`);
  parts.push(`from ${quote(ast.from.model.table)} as ${quote(ast.from.alias)}`);
  for (const j of ast.joins) parts.push(`${j.kind === "left" ? "left join" : "join"} ${quote(j.source.model.table)} as ${quote(j.source.alias)} on ${expr(j.on, params)}`);
  const where: string[] = [];
  // The parent's key set: its own filters (and, recursively, its parent's), order, limit and offset.
  if (link !== null) where.push(`${expr(link.childKey, params)} in (${selectSql(link.parentAst, params, [expr(link.parentKey, params)], link.parentLink)})`);
  for (const w of ast.where) where.push(expr(w, params));
  if (where.length > 0) parts.push(`where ${where.join(" and ")}`);
  if (ast.groupBy.length > 0) parts.push(`group by ${ast.groupBy.map((g) => expr(g, params)).join(", ")}`);
  if (ast.having.length > 0) parts.push(`having ${ast.having.map((h) => expr(h, params)).join(" and ")}`);
  if (ast.orderBy.length > 0) parts.push(`order by ${ast.orderBy.map((o) => `${expr(o.expr, params)} ${o.dir}${o.nulls === null ? "" : ` nulls ${o.nulls}`}`).join(", ")}`);
  if (ast.limit !== null) parts.push(`limit ${expr(ast.limit, params)}`);
  if (ast.offset !== null) parts.push(`offset ${expr(ast.offset, params)}`);
  return parts.join(" ");
}

function returning(fields: Field[], params: Params): string {
  if (fields.length === 0) return "";
  const cols: string[] = [];
  for (const f of fields) {
    if (f.type !== "value") throw new Error("returning(...) cannot load relations");
    cols.push(selected(f.expr, f.kind, params));
  }
  return ` returning ${cols.join(", ")}`;
}

function valueFields(fields: Field[], start: number): PlanValue[] {
  const out: PlanValue[] = [];
  let i = start;
  for (const f of fields) {
    if (f.type !== "value") continue;
    const enumField = f.expr instanceof ColumnNode && f.expr.model.kinds[f.expr.model.keys.indexOf(f.expr.field)] === "enum";
    out.push({ type: "value", name: f.name, index: i++, kind: f.kind, nullable: f.nullable, enumField });
  }
  return out;
}

function mutationPlan(ast: InsertAst | UpdateAst | DeleteAst, mode: ResultMode, inferred: PlanParam[] | null): Plan {
  const uses = new Uses();
  if (ast instanceof InsertAst) {
    uses.assigned(ast.values);
    if (ast.conflict !== null && ast.conflict.update !== null) uses.assigned(ast.conflict.update);
  } else {
    if (ast instanceof UpdateAst) uses.assigned(ast.set);
    for (const w of ast.where) uses.node(w);
  }
  for (const f of ast.returning) if (f.type === "value") uses.node(f.expr);
  const params = new Params(uses.bare());
  let sql: string;
  let fields: Field[];
  if (ast instanceof InsertAst) {
    const cols = ast.values.map((v) => quote(v.column));
    const vals = ast.values.map((v) => expr(v.value, params));
    sql = cols.length === 0 ? `insert into ${quote(ast.model.table)} default values` : `insert into ${quote(ast.model.table)} (${cols.join(", ")}) values (${vals.join(", ")})`;
    if (ast.conflict !== null) {
      const target = `(${ast.conflict.columns.map(quote).join(", ")})`;
      sql +=
        ast.conflict.update === null || ast.conflict.update.length === 0
          ? ` on conflict ${target} do nothing`
          : ` on conflict ${target} do update set ${ast.conflict.update.map((a) => `${quote(a.column)} = ${expr(a.value, params)}`).join(", ")}`;
    }
    fields = ast.returning;
  } else if (ast instanceof UpdateAst) {
    if (ast.set.length === 0) throw new Error("update(...) needs at least one value");
    sql = `update ${quote(ast.source.model.table)} as ${quote(ast.source.alias)} set ${ast.set.map((a) => `${quote(a.column)} = ${expr(a.value, params)}`).join(", ")}`;
    if (ast.where.length > 0) sql += ` where ${ast.where.map((w) => expr(w, params)).join(" and ")}`;
    fields = ast.returning;
  } else {
    sql = `delete from ${quote(ast.source.model.table)} as ${quote(ast.source.alias)}`;
    if (ast.where.length > 0) sql += ` where ${ast.where.map((w) => expr(w, params)).join(" and ")}`;
    fields = ast.returning;
  }
  sql += returning(fields, params);
  return { mode, statements: [{ sql, params: params.list }], levels: [{ statement: 0, cardinality: "root", parent: -1, fields: valueFields(fields, 0) }], inferred };
}

/** Compiles a declared query (its built AST) into SQL statements and a decoding plan. */
export function compileQuery(def: AnyQueryDef): Plan {
  const built = def.built;
  const inferred: PlanParam[] | null = def.inferred === null ? null : def.inferred.map((p) => ({ name: p.name, kind: p.kind, array: p.array, optional: p.optional }));
  if (!(built.ast instanceof SelectAst)) return mutationPlan(built.ast as InsertAst | UpdateAst | DeleteAst, built.mode, inferred);
  const statements: PlanStatement[] = [];
  const levels: PlanLevel[] = [];

  const compileLevel = (ast: SelectAst, link: KeyLink | null, cardinality: PlanLevel["cardinality"], parentLevel: number): number => {
    const uses = new Uses();
    uses.select(ast);
    for (let l: KeyLink | null = link; l !== null; l = l.parentLink) {
      uses.node(l.childKey);
      uses.node(l.parentKey);
      uses.select(l.parentAst);
    }
    for (const f of ast.fields) if (f.type === "relation") uses.node(f.relation.parentKey);
    const params = new Params(uses.bare());
    const index = levels.length;
    const level: PlanLevel = { statement: index, cardinality, parent: parentLevel, fields: [] };
    levels.push(level);
    statements.push({ sql: "", params: [] });
    const columns: string[] = [];
    if (link !== null) columns.push(expr(link.childKey, params));
    let col = columns.length;
    const pending: { name: string; relation: RelationAst; keyIndex: number }[] = [];
    for (const f of ast.fields) {
      if (f.type === "value") {
        columns.push(selected(f.expr, f.kind, params));
        const enumField = f.expr instanceof ColumnNode && f.expr.model.kinds[f.expr.model.keys.indexOf(f.expr.field)] === "enum";
        level.fields.push({ type: "value", name: f.name, index: col++, kind: f.kind, nullable: f.nullable, enumField });
      } else {
        // Hidden key column: the parent's value the relation's children are grouped by.
        columns.push(expr(f.relation.parentKey, params));
        const placeholder: PlanRelation = { type: "relation", name: f.name, level: -1, keyIndex: col++ };
        level.fields.push(placeholder);
        pending.push({ name: f.name, relation: f.relation, keyIndex: placeholder.keyIndex });
      }
    }
    statements[index] = { sql: selectSql(ast, params, columns, link), params: params.list };
    for (const p of pending) {
      for (const j of p.relation.child.joins) if (j.source.alias === ast.from.alias) throw new Error(`Relation "${p.name}" reuses alias "${ast.from.alias}"`);
      if (p.relation.child.from.alias === ast.from.alias) throw new Error(`Relation "${p.name}" must use a different alias than its parent ("${ast.from.alias}")`);
      const childLink: KeyLink = { childKey: p.relation.childKey, parentAst: ast, parentKey: p.relation.parentKey, parentLink: link };
      const childIndex = compileLevel(p.relation.child, childLink, p.relation.cardinality, index);
      const field = level.fields.find((x) => x.type === "relation" && x.name === p.name) as PlanRelation;
      field.level = childIndex;
    }
    return index;
  };

  compileLevel(built.ast, null, "root", -1);
  return { mode: built.mode, statements, levels, inferred };
}
