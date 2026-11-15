/**
 * The run-time half of the query compiler. `qala generate` compiles every `defineQuery` in
 * `app/infrastructure/queries/*.query.ts` into `.qala/queries.gen.ts`: final SQL per statement, a typed
 * parameter mapper and a typed result assembler. At run time nothing is built: the statements of a query
 * (one per relation level) go to PostgreSQL in one pipelined round trip as prepared statements, and the
 * generated code decodes the text rows into their static shape.
 *
 * Everything here is non-generic at run time (scriptc compiles it to native code); the parameter and
 * result types travel as phantoms (`Query<P, R>`).
 */
import type { DbValue, PipelineItem, RawResult } from "../db/pg";

/** Builds a statement's parameter list from the query's parameters (generated, typed). */
export type ParamMapper = (params: unknown) => DbValue[];
/** Turns the raw results of every statement (in order) into the query result (generated, typed). */
export type Assembler = (results: RawResult[]) => unknown;

/** One SQL statement of a compiled query. */
export class QueryStep {
  constructor(
    readonly sql: string,
    readonly params: ParamMapper,
  ) {}
}

/** A compiled query at run time. Use the typed `Query<P, R>` view. */
export class CompiledQuery {
  constructor(
    readonly name: string,
    readonly steps: QueryStep[],
    readonly assemble: Assembler,
  ) {}
}

/** The typed view of a compiled query: `P` its parameters, `R` its result. */
export type Query<P, R> = CompiledQuery & { readonly __query?: () => { params: P; result: R } };
export type QueryParamsOf<Q> = Q extends { readonly __query?: () => { params: infer P; result: unknown } } ? P : never;
export type QueryResultOf<Q> = Q extends { readonly __query?: () => { params: unknown; result: infer R } } ? R : never;

/** Used by generated code: a statement whose parameters come from the typed mapper `map`. */
export function step<P>(sql: string, map: (params: P) => DbValue[]): QueryStep {
  const loose: unknown = map;
  return new QueryStep(sql, loose as ParamMapper);
}

/** Used by generated code: the typed query object. */
export function compiled<P, R>(name: string, steps: QueryStep[], assemble: (results: RawResult[]) => R): Query<P, R> {
  const loose: unknown = assemble;
  return new CompiledQuery(name, steps, loose as Assembler);
}

/** Anything that can run several statements in one round trip (`Database`, `Transaction`). */
export type BatchRunner = { batchRaw(items: PipelineItem[]): Promise<RawResult[]> };

/** The statements of `query` for `params`, ready for the pipeline. */
function itemsOf(query: CompiledQuery, params: unknown): PipelineItem[] {
  const items: PipelineItem[] = [];
  for (const s of query.steps) items.push({ text: s.sql, params: s.params(params) });
  return items;
}

/**
 * Runs a compiled query: every statement in one pipelined round trip.
 *
 *   const board = await run(db, Queries.boardTasks, { projectId });
 */
export async function run<P, R>(db: BatchRunner, query: Query<P, R>, params: P): Promise<R> {
  const results = await db.batchRaw(itemsOf(query, params));
  const value: unknown = query.assemble(results);
  return value as R;
}

/** One entry of a batch: the query and its parameters. */
export type BatchEntry<P, R> = [Query<P, R>, P];
type BatchResults<B> = { [K in keyof B]: B[K] extends [infer Q, unknown] ? QueryResultOf<Q> : never };
/** Each entry's parameters checked against its own query. */
type CheckedBatch<B> = { [K in keyof B]: B[K] extends [infer Q, unknown] ? [Q, QueryParamsOf<Q>] : never };

/**
 * Runs several compiled queries in ONE round trip (all their statements pipelined) and returns their
 * results by name:
 *
 *   const { tasks, members } = await batch(db, {
 *     tasks: [Queries.boardTasks, { projectId }],
 *     members: [Queries.projectMembers, { projectId }],
 *   });
 */
export async function batch<B extends Record<string, [CompiledQuery, unknown]>>(db: BatchRunner, entries: B & CheckedBatch<B>): Promise<BatchResults<B>> {
  // One homogeneous view of the entries (their typed shapes differ per key, which native code cannot index).
  const loose: unknown = entries;
  const all = loose as Record<string, [CompiledQuery, unknown]>;
  const names = Object.keys(all);
  const items: PipelineItem[] = [];
  const counts: number[] = [];
  const queries: CompiledQuery[] = [];
  for (const name of names) {
    const entry = all[name]!;
    const query: CompiledQuery = entry[0];
    const its = itemsOf(query, entry[1]);
    for (const it of its) items.push(it);
    counts.push(its.length);
    queries.push(query);
  }
  const results = await db.batchRaw(items);
  const out: Record<string, unknown> = {};
  let at = 0;
  for (let i = 0; i < names.length; i++) {
    const n = counts[i]!;
    out[names[i]!] = queries[i]!.assemble(results.slice(at, at + n));
    at += n;
  }
  const value: unknown = out;
  return value as BatchResults<B>;
}

/** A PostgreSQL array literal (`{"a","b"}`) for array parameters; elements are quoted and escaped. */
export function pgArray(values: readonly (string | number | boolean)[]): string {
  const parts: string[] = [];
  for (const v of values) {
    if (typeof v === "number") parts.push(String(v));
    else if (typeof v === "boolean") parts.push(v ? "t" : "f");
    else parts.push(`"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  }
  return `{${parts.join(",")}}`;
}

/** Appends `row` to the list under `key` (used by generated relation stitching). */
export function groupPush<T>(groups: Map<string, T[]>, key: string, row: T): void {
  const list = groups.get(key);
  if (list === undefined) groups.set(key, [row]);
  else list.push(row);
}
