/**
 * The query AST the builder produces and the compiler turns into SQL. Build-time only (runs on Bun
 * inside `qala generate`); never part of a native program.
 */
import type { ModelDef } from "../../db/model";

/** How a value is decoded from Postgres text and which SQL type a parameter is cast to. */
export type ValueKind = "text" | "uuid" | "integer" | "bigint" | "number" | "boolean" | "datetime";

export const SQL_TYPE: Record<ValueKind, string> = {
  text: "text",
  uuid: "uuid",
  integer: "int4",
  bigint: "int8",
  number: "float8",
  boolean: "bool",
  datetime: "timestamptz",
};

/** The value kind of a model field's schema kind. */
export function kindOfField(schemaKind: string): ValueKind {
  if (schemaKind === "uuid") return "uuid";
  if (schemaKind === "integer") return "integer";
  if (schemaKind === "number") return "number";
  if (schemaKind === "boolean") return "boolean";
  if (schemaKind === "datetime") return "datetime";
  return "text";
}

export type Node = ColumnNode | ParamNode | LiteralNode | BinaryNode | LogicalNode | NotNode | NullTestNode | InNode | LikeNode | ExistsNode | AggregateNode | RawNode;

export class ColumnNode {
  readonly type = "column";
  constructor(
    readonly alias: string,
    readonly model: ModelDef,
    readonly field: string,
    readonly column: string,
    readonly kind: ValueKind,
    readonly nullable: boolean,
  ) {}
}

export class ParamNode {
  readonly type = "param";
  constructor(
    readonly name: string,
    readonly kind: ValueKind,
    readonly array: boolean,
    readonly optional: boolean,
  ) {}
}

export class LiteralNode {
  readonly type = "literal";
  constructor(readonly value: string | number | boolean | null) {}
}

export type ComparisonOp = "=" | "<>" | "<" | ">" | "<=" | ">=";

export class BinaryNode {
  readonly type = "binary";
  constructor(
    readonly op: ComparisonOp,
    readonly left: Node,
    readonly right: Node,
  ) {}
}

export class LogicalNode {
  readonly type = "logical";
  constructor(
    readonly op: "and" | "or",
    readonly items: Node[],
  ) {}
}

export class NotNode {
  readonly type = "not";
  constructor(readonly inner: Node) {}
}

export class NullTestNode {
  readonly type = "nulltest";
  constructor(
    readonly inner: Node,
    readonly negate: boolean,
  ) {}
}

export class InNode {
  readonly type = "in";
  /** `list` is an array parameter or literal values. */
  constructor(
    readonly inner: Node,
    readonly list: ParamNode | LiteralNode[],
  ) {}
}

export class LikeNode {
  readonly type = "like";
  constructor(
    readonly inner: Node,
    readonly pattern: Node,
    readonly insensitive: boolean,
  ) {}
}

export class ExistsNode {
  readonly type = "exists";
  constructor(
    readonly query: SelectAst,
    readonly negate: boolean,
  ) {}
}

export type AggregateFn = "count" | "sum" | "min" | "max" | "avg";

export class AggregateNode {
  readonly type = "aggregate";
  constructor(
    readonly fn: AggregateFn,
    /** null for count(*). */
    readonly inner: Node | null,
    readonly kind: ValueKind,
    readonly distinct: boolean,
  ) {}
}

/** A raw SQL fragment with `{0}`, `{1}` holes filled by `args` (escape hatch, e.g. `lower({0})`). */
export class RawNode {
  readonly type = "raw";
  constructor(
    readonly sql: string,
    readonly args: Node[],
    readonly kind: ValueKind,
  ) {}
}

export type Source = { alias: string; model: ModelDef };
export type Join = { kind: "inner" | "left"; source: Source; on: Node };
export type Order = { expr: Node; dir: "asc" | "desc"; nulls: "first" | "last" | null };

/** A selected value: a column/expression, or a relation loaded by its own statement. */
export type Field =
  | { type: "value"; name: string; expr: Node; kind: ValueKind; nullable: boolean }
  | { type: "relation"; name: string; relation: RelationAst };

export class RelationAst {
  constructor(
    readonly cardinality: "many" | "one",
    /** The child query (its own source, filters, order, selection). */
    readonly child: SelectAst,
    /** Expression on the child that must equal `parentKey`. */
    readonly childKey: Node,
    /** Expression on the parent row. */
    readonly parentKey: Node,
  ) {}
}

export class SelectAst {
  from: Source;
  joins: Join[] = [];
  where: Node[] = [];
  groupBy: Node[] = [];
  having: Node[] = [];
  orderBy: Order[] = [];
  limit: Node | null = null;
  offset: Node | null = null;
  distinct = false;
  fields: Field[] = [];
  constructor(from: Source) {
    this.from = from;
  }

  clone(): SelectAst {
    const c = new SelectAst(this.from);
    c.joins = [...this.joins];
    c.where = [...this.where];
    c.groupBy = [...this.groupBy];
    c.having = [...this.having];
    c.orderBy = [...this.orderBy];
    c.limit = this.limit;
    c.offset = this.offset;
    c.distinct = this.distinct;
    c.fields = [...this.fields];
    return c;
  }
}

export type Assignment = { column: string; field: string; value: Node; kind: ValueKind };

export class InsertAst {
  constructor(
    readonly model: ModelDef,
    readonly values: Assignment[],
    readonly returning: Field[],
    readonly conflict: { columns: string[]; update: Assignment[] | null } | null,
  ) {}
}

export class UpdateAst {
  constructor(
    readonly source: Source,
    readonly set: Assignment[],
    readonly where: Node[],
    readonly returning: Field[],
  ) {}
}

export class DeleteAst {
  constructor(
    readonly source: Source,
    readonly where: Node[],
    readonly returning: Field[],
  ) {}
}

/** What a query returns: all rows, the first row or null, or the affected-row count. */
export type ResultMode = "many" | "first" | "affected";

export type StatementAst = SelectAst | InsertAst | UpdateAst | DeleteAst;
