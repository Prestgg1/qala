# Queries: a compiler, not a runtime ORM

Qala's ORM works like a compiler. You declare queries in TypeScript over your `model()` definitions; `qala generate` (also run by `dev` and `build`) compiles each one into final SQL, a typed parameter mapper and a typed row decoder in `.qala/queries.gen.ts`. At run time nothing is built or parsed: the statements go to PostgreSQL as prepared statements in one pipelined round trip and the generated code decodes the rows straight into their static shape — which scriptc compiles to native code.

```
app/infrastructure/queries/tasks.query.ts   ──qala generate──▶   .qala/queries.gen.ts   ◀── app/infrastructure/*.repository.ts
   defineQuery(...)   (build time only)                           SQL + typed decoders        run(db, Queries.x, params)
```

## Declaring a query

```ts
// app/infrastructure/queries/tasks.query.ts
import { and, asc, defineQuery, desc, eq, from, ilike, many, one, param } from "@qala/core/query";
import { Comment, Project, Task } from "../../domain/models";

export const projectTasks = defineQuery({
  params: {
    projectId: param.uuid(),
    status: param.optional(param.enum(["todo", "doing", "done"])),
    q: param.optional(param.text()),
    limit: param.optional(param.int()),
  },
  query: (p) =>
    from({ t: Task })
      .where((r) => and(eq(r.t.projectId, p.projectId), eq(r.t.status, p.status), ilike(r.t.title, p.q)))
      .orderBy((r) => [desc(r.t.priority), asc(r.t.title)])
      .limit(p.limit)
      .select((r) => ({
        id: r.t.id,
        title: r.t.title,
        project: one({ pr: Project }, { key: (c) => c.pr.id, parent: r.t.projectId }),
        comments: many({ c: Comment }, {
          key: (c) => c.c.taskId,
          parent: r.t.id,
          query: (q) => q.orderBy((c) => [asc(c.c.createdAt)]).select((c) => ({ id: c.c.id, body: c.c.body })),
        }),
      })),
});
```

Query files live in `app/infrastructure/queries/*.query.ts` and import the builder from `@qala/core/query`. They are build-time only: `qala check` rejects any run-time import of them, and the native binary does not contain the builder.

## Running it

```ts
// app/infrastructure/pg-task.repository.ts
import { batch, run, type Database } from "@qala/core";
import { Queries } from "../../.qala/queries.gen";

const tasks = await run(db, Queries.projectTasks, { projectId, status: "todo" });
//    ^ { id: string; title: string; project: { id: string; name: string; ... } | null; comments: { id: string; body: string }[] }[]

// Several queries, ONE round trip, results by name:
const { tasks, summary } = await batch(db, {
  tasks: [Queries.projectTasks, { projectId }],
  summary: [Queries.statusSummary, { projectId }],
});

// Inside a transaction: pass the transaction instead of the database.
await db.transaction(async (tx) => run(tx, Queries.createTask, { projectId, title, priority: 2 }));
```

Only `app/infrastructure` may import `.qala/queries.gen` (`qala check`); the rest of the app talks to repositories.

## The builder

| | |
|---|---|
| sources | `from({ t: Task })`, `.join({ p: Project }, (r) => eq(r.p.id, r.t.projectId))`, `.leftJoin(...)` (its columns become `\| null`) |
| filters | `eq ne lt gt lte gte`, `inList(col, param.array(...) \| [values])`, `like ilike`, `isNull isNotNull`, `and or not`, `exists notExists` (correlated subqueries) |
| shaping | `.select((r) => ({ ... }))` or `.select((r) => r.t)` for whole rows, `.orderBy((r) => [desc(x), y])`, `.limit(n \| param)`, `.offset(...)`, `.distinct()`, `.first()` → `Row \| null` |
| aggregates | `count() countDistinct sum avg min max`, `.groupBy(...)`, `.having(...)` |
| relations | `many(...)` → array, `one(...)` → row or null, nested to any depth |
| writes | `insertInto(Task, { ... }).onConflict([...], update?).returning(...)`, `update({ t: Task }, { ... }).where(...).returning(...)`, `deleteFrom({ t: Task }).where(...)` — without `returning` the result is the affected-row count |
| escape hatch | `sql<number>("integer", "extract(day from {0})", r.t.dueAt)` — `{n}` holes take expressions or values, never spliced text |

Parameters: `param.uuid() text() int() bigint() number() boolean() datetime() enum([...]) array(p) optional(p)`.

### Optional parameters compile to static SQL

A condition that uses an optional parameter is skipped when the parameter is absent or null, without building SQL at run time:

```sql
where ("t"."project_id" = $1::uuid and ($2::text is null or "t"."status" = $2::text))
```

`limit(p.limit)` with an optional `limit` means "no limit" when it is left out.

### Relations: no N+1, one round trip

Each relation level is its own statement selecting the children whose key is in the parent's **key set**, written as a subquery over the parent's own filters, order and limit:

```sql
select "c"."task_id", "c"."id", "c"."body" from "comments" as "c"
where "c"."task_id" in (select "t"."id" from "tasks" as "t" where <parent filters> order by ... limit $4)
order by "c"."created_at" asc
```

So every level depends only on the query's parameters — not on the parent's results — and all levels are sent together in one pipelined round trip (two levels deep = three statements, one round trip). Generated code groups the children by key and attaches them; their order is the child query's `orderBy`.

Trade-offs: the parent's filter is evaluated once per level (PostgreSQL usually plans it as a semi-join on an index); outside a transaction each statement sees its own snapshot, so wrap the call in `db.transaction` when levels must be read at one instant. Relations cannot take `limit`/`offset` (that would apply across all parents); filter them instead.

## Type safety

- Parameters are typed from their declaration (`param.optional(...)` keys are optional and accept `null`), and every `batch` entry is checked against its own query.
- Results are typed exactly: nullable columns and left joins give `| null`, `many` gives arrays, `one` gives `Row | null`, aggregates give `number` / `T | null`.
- Comparisons are checked against the column type (`eq(r.t.id, p.count)` on a uuid column with an int parameter is a type error).
- `.qala/queries.gen.ts` takes its types from the declarations (`import type`), so a declaration changed without regenerating makes `tsc` fail instead of returning the wrong shape.

## What the generated code looks like

```ts
export const topTask = compiled<P_topTask, R_topTask>(
  "topTask",
  [
    step<P_topTask>('select "t"."id", "t"."title" from "tasks" as "t" where "t"."project_id" = $1::uuid order by "t"."priority" desc limit 1',
      (p: P_topTask): DbValue[] => [p.projectId]),
  ],
  (rs: RawResult[]): R_topTask => {
    const out: E_topTask_0[] = [];
    for (const v of rs[0]!.rows) out.push({ id: v[0] ?? "", title: v[1] ?? "" });
    return out.length === 0 ? null : out[0]!;
  },
);
```
