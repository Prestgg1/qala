/** Type-level tests for the ORM (checked by `tsc`, not run). */
import { batch, type Database, run } from "@qala/core";
import { defineQuery, eq, from, param } from "@qala/core/query";
import { Task } from "./fixtures/orm/models";
import { Queries } from "./fixtures/orm/queries.gen";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

declare const db: Database;

export async function checks(): Promise<void> {
  const tasks = await run(db, Queries.projectTasks, { projectId: "x" });
  type Row = (typeof tasks)[number];
  type _row = Expect<
    Equal<
      Row,
      {
        id: string;
        title: string;
        status: "todo" | "doing" | "done";
        estimate: number | null;
        dueAt: string | null;
        project: { id: string; name: string } | null;
        comments: { id: string; body: string; reactions: { emoji: string }[] }[];
      }
    >
  >;
  const top = await run(db, Queries.topTask, { projectId: "x" });
  type _top = Expect<Equal<typeof top, { id: string; title: string } | null>>;
  const titles = await run(db, Queries.projectTaskTitles, {});
  type _left = Expect<Equal<(typeof titles)[number], { project: string; title: string | null; priority: number | null }>>;
  const n = await run(db, Queries.deleteTask, { id: "x" });
  type _n = Expect<Equal<typeof n, number>>;
  const b = await batch(db, { a: [Queries.topTask, { projectId: "x" }], c: [Queries.deleteTask, { id: "y" }] });
  type _b = Expect<Equal<typeof b, { a: { id: string; title: string } | null; c: number }>>;

  // @ts-expect-error missing required parameter
  await run(db, Queries.projectTasks, {});
  // @ts-expect-error wrong parameter type
  await run(db, Queries.projectTasks, { projectId: 1 });
  // @ts-expect-error enum parameter outside its values
  await run(db, Queries.projectTasks, { projectId: "x", status: "archived" });
  // @ts-expect-error unknown parameter
  await run(db, Queries.topTask, { projectId: "x", extra: 1 });
  // @ts-expect-error no such result field
  void tasks[0]?.priority;
  // @ts-expect-error batch entry parameters are checked too
  await batch(db, { a: [Queries.topTask, { id: "x" }] });
}

// Declarations are typed against the models too.
export const bad = defineQuery({
  params: { id: param.int() },
  // @ts-expect-error a uuid column compared with an int parameter
  query: (p) => from({ t: Task }).where((r) => eq(r.t.id, p.id)).select((r) => ({ id: r.t.id })),
});
export const badField = defineQuery({
  // @ts-expect-error no such column
  query: () => from({ t: Task }).select((r) => ({ x: r.t.nope })),
});
