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
export type Plan = { mode: ResultMode; statements: PlanStatement[]; levels: PlanLevel[] };

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

/** Parameters of one statement, numbered in order of first use. */
class Params {
  readonly list: PlanParam[] = [];
  ref(p: ParamNode): string {
    let i = this.list.findIndex((x) => x.name === p.name);
    if (i === -1) {
      this.list.push({ name: p.name, kind: p.kind, array: p.array, optional: p.optional });
      i = this.list.length - 1;
    }
    return `$${i + 1}::${SQL_TYPE[p.kind]}${p.array ? "[]" : ""}`;
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

/** Wraps a predicate that uses optional parameters: it holds when any of them is null. */
function guarded(node: Node, sql: string, params: Params): string {
  const opt = optionalParams(node, []);
  if (opt.length === 0) return sql;
  const tests = opt.map((p) => `${params.ref(p)} is null`);
  return `(${tests.join(" or ")} or ${sql})`;
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

function mutationPlan(ast: InsertAst | UpdateAst | DeleteAst, mode: ResultMode): Plan {
  const params = new Params();
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
  return { mode, statements: [{ sql, params: params.list }], levels: [{ statement: 0, cardinality: "root", parent: -1, fields: valueFields(fields, 0) }] };
}

/** Compiles a declared query (its built AST) into SQL statements and a decoding plan. */
export function compileQuery(def: AnyQueryDef): Plan {
  const built = def.built;
  if (!(built.ast instanceof SelectAst)) return mutationPlan(built.ast as InsertAst | UpdateAst | DeleteAst, built.mode);
  const statements: PlanStatement[] = [];
  const levels: PlanLevel[] = [];

  const compileLevel = (ast: SelectAst, link: KeyLink | null, cardinality: PlanLevel["cardinality"], parentLevel: number): number => {
    const params = new Params();
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
  return { mode: built.mode, statements, levels };
}
