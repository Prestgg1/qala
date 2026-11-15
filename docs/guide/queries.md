# Queries

Qala's ORM is a compiler. You write queries in TypeScript over your models; `qala generate` (also run by
`dev` and `build`) turns each one into final SQL, a typed parameter mapper and a typed row decoder in
`.qala/queries.gen.ts`. At run time nothing is built or parsed: the statements go to PostgreSQL as prepared
statements in one pipelined round trip, and the generated code decodes rows straight into their static
shape, which scriptc compiles to native code.

```
app/infrastructure/queries/tasks.query.ts  ──qala generate──▶  .qala/queries.gen.ts  ◀──  repositories
   query(($) => …)   (build time only)                         SQL + typed decoders       run(db, Queries.x, params)
```

## A query in one line

```ts
// app/infrastructure/queries/tasks.query.ts
import { from, query } from "@qala/core/query";
import { Task } from "../../domain/task";

export const projectTasks = query(($) => from(Task).where((t) => t.projectId.eq($.projectId)).orderBy((t) => [t.position]));
```

- `$.projectId` is a parameter. Its type is taken from the column it is compared with (`uuid` here), so you
  never declare it. The generated file spells it out: `type P_projectTasks = { projectId: string }`.
- `from(Task)` without `.select(...)` returns whole rows (`Task[]`).
- Callbacks get the table's columns directly: `(t) => t.title`.

Run it from a repository:

```ts
import { run } from "@qala/core";
import { Queries } from "../../.qala/queries.gen";

const tasks = await run(db, Queries.projectTasks, { projectId });   // Task[]
```

Before / after:

```ts
// before
export const projectTasks = defineQuery({
  params: { projectId: param.uuid() },
  query: (p) => from({ t: Task }).where((r) => eq(r.t.projectId, p.projectId)).orderBy((r) => [r.t.position]).select((r) => r.t),
});

// after
export const projectTasks = query(($) => from(Task).where((t) => t.projectId.eq($.projectId)).orderBy((t) => [t.position]));
```

`defineQuery({ params, query })` keeps working; use it when you want parameter types written out.

## Parameters

| you write | the parameter becomes |
|---|---|
| `t.projectId.eq($.projectId)` | the column's type (`string` for uuid/text, `number`, `boolean`, …) |
| `t.status.eq($.status.optional())` | optional: the condition is skipped when it is absent or null |
| `t.id.in($.ids)` | an array of the column's type (`string[]`) |
| `t.title.ilike($.q)` | `string` |
| `.limit($.limit)` / `.offset($.offset)` | `number` |
| `insertInto(Task, { title: $.title })`, `update(Task, { done: $.done })` | the assigned column's type |
| `sql<string>("text", "upper({0})", $.label.as("text"))` | what `.as(...)` names (raw SQL has no column to infer from) |

A parameter nothing types, or one used as two different types, fails `qala generate` with its name:
`Cannot infer the type of $.label: compare it with a column, assign it to one, or write $.label.as("integer")`.

Enum columns get their values typed as `string` in the generated parameter type; Postgres still rejects a
value outside the enum.

## No casts to write

A parameter that is only compared with or assigned to a column is sent without a cast, so PostgreSQL gives it
that column's exact type. Enum, jsonb and domain columns therefore need no `::status` or `::text` in your
code:

```ts
export const ticketsByStatus = query(($) => from(Ticket).where((t) => t.status.eq($.status.optional())));
```

```sql
select … from "tickets" as "tickets" where ("tickets"."status" = $1 or $1 is null)
```

Optional conditions put the comparison first (`col = $1 or $1 is null`) so the type is inferred from the
column. Parameters used elsewhere (raw SQL, `like` patterns, `limit`) keep an explicit cast.

`coalesce(expr, fallback)` is typed without `| null`, so the common `notNull(sql(...coalesce...))` becomes:

```ts
select((t) => ({ total: coalesce(sum(t.priority), 0) }))   // { total: number }
```

## The builder

| | |
|---|---|
| sources | `from(Task)` (columns as `(t) => t.title`); for joins name them: `from({ t: Task }).join({ p: Project }, (r) => r.p.id.eq(r.t.projectId))`, `.leftJoin(...)` (its columns become `\| null`) |
| filters | column methods `eq ne lt gt lte gte in like ilike isNull isNotNull`; `and or not`; `exists notExists` (correlated subqueries). The functions `eq(a, b)`, `inList(a, list)`, … still work |
| shaping | `.select((t) => ({ … }))`, nothing for whole rows, `.orderBy((t) => [t.priority.desc(), t.title])`, `.limit`, `.offset`, `.distinct()`, `.first()` → `Row \| null` |
| aggregates | `count() countDistinct sum avg min max`, `coalesce`, `.groupBy(...)`, `.having(...)` |
| relations | `many(Comment, { key: (c) => c.taskId, parent: t.id })` → array, `one(Project, { key: (p) => p.id, parent: t.projectId })` → row or null, nested to any depth, optional `query: (q) => q.orderBy(…).select(…)` |
| writes | `insertInto(Task, { … }).onConflict([...], update?).returning(...)`, `update(Task, { … }).where((t) => …).returning(...)`, `deleteFrom(Task).where(...)`; without `returning` the result is the affected-row count |
| escape hatch | `sql<number>("integer", "extract(day from {0})", t.dueAt)`: `{n}` holes take expressions or values, never spliced text; typed `T \| null` |

## Running

```ts
const tasks = await run(db, Queries.projectTasks, { projectId });

// several queries, ONE round trip, results by name
const { tasks, summary } = await batch(db, {
  tasks: [Queries.projectTasks, { projectId }],
  summary: [Queries.statusSummary, { projectId }],
});

// in a transaction: pass it instead of the database
await db.transaction((tx) => run(tx, Queries.createTask, { projectId, title }));
```

Query files live in `app/infrastructure/queries/*.query.ts` and are build-time only: `qala check` rejects
any run-time import of them, and the native binary contains none of the builder. Only `app/infrastructure`
may import `.qala/queries.gen`.

## Relations: no N+1, one round trip

Each relation level is its own statement selecting the children whose key is in the parent's key set,
written as a subquery over the parent's own filters, order and limit:

```sql
select "comments"."task_id", "comments"."body" from "comments" as "comments"
where "comments"."task_id" in (select "tasks"."id" from "tasks" as "tasks" where <parent filters> order by … limit $4)
```

Every level depends only on the query's parameters, so all levels go to PostgreSQL together (two levels
deep = three statements, one round trip). Generated code groups the children by key.

Trade-offs: the parent's filter runs once per level (usually a semi-join on an index); outside a
transaction each statement sees its own snapshot, so use `db.transaction` when the levels must be read at
one instant. Relations cannot take `limit`/`offset`; filter instead. A relation to the same model as its
parent (e.g. subtasks) needs named sources so the aliases differ.

## Type safety

- Parameters: inferred from use (`query`) or declared (`defineQuery`); the generated type is what callers
  of `run` must pass, and every `batch` entry is checked against its own query.
- Results are exact: nullable columns and left joins give `| null`, `many` gives arrays, `one` gives
  `Row | null`, aggregates give `number` / `T | null`.
- `.qala/queries.gen.ts` takes result types from the declarations (`import type`), so a query changed
  without regenerating fails `tsc`.

## What the generated code looks like

```ts
type P_projectTasks = { projectId: string };
export const projectTasks = compiled<P_projectTasks, R_projectTasks>(
  "projectTasks",
  [
    step<P_projectTasks>('select "tasks"."id", "tasks"."title", … from "tasks" as "tasks" where "tasks"."project_id" = $1 order by "tasks"."position" asc',
      (p: P_projectTasks): DbValue[] => [p.projectId]),
  ],
  (rs: RawResult[]): R_projectTasks => {
    const out: E_projectTasks_0[] = [];
    for (const v of rs[0]!.rows) out.push({ id: v[0] ?? "", title: v[1] ?? "", … });
    return out;
  },
);
```

Model events (`on(Task, "created", …)`, audit, realtime) fire for `db.table(Model)` writes, not for compiled
queries: see [events](events.md).
