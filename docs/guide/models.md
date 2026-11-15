# Models

A model is the single source of truth for a table. From one definition Qala derives the row type, insert and update
validation, the typed client's input types, the generated row decoder and the migrations.

```ts
// app/domain/task.ts
import { model, t, type InferModel } from "@qala/core";
import { Project } from "./project";

export const Task = model("tasks", {
  id: t.uuid().primary(),
  title: t.string({ min: 1, max: 200 }),
  done: t.boolean().default(false),
  priority: t.integer().default(1).index(),
  note: t.string().nullable(),
  projectId: t.uuid().references(Project, { onDelete: "cascade" }),
  parentId: t.uuid().nullable().referencesSelf(),
  createdAt: t.datetime().now(),
});
export type Task = InferModel<typeof Task>;
```

Field names are camelCase in TypeScript and snake_case in the database (`projectId` ↔ `project_id`).

## Column modifiers

| modifier | means |
|---|---|
| `.primary()` | primary key; a uuid key defaults to `gen_random_uuid()`, an integer key is an identity column |
| `.default(value)` | database default (`false`, `0`, `'todo'`); the field is optional on insert |
| `.defaultSql("expr")` | default as SQL (`"now()"`, `"gen_random_uuid()"`) |
| `.now()` | shorthand for `.defaultSql("now()")` |
| `.nullable()` | the column accepts NULL; the value type gains `\| null`. Call it before `.default(...)` |
| `.unique()` / `.index()` | unique constraint / index on the column |
| `.references(Model, { onDelete })` | foreign key to another model's primary key (`"cascade"`, `"set null"`, `"restrict"`, `"no action"`) |
| `.referencesSelf({ onDelete })` | foreign key to the model's own primary key (trees, parents) |
| `.type("varchar(200)")` | explicit SQL type instead of the kind's default |

Validation rules (`t.string({ max: 200 })`) and modifiers combine freely. Modifiers never change validation, except
`.nullable()`.

## Create and update types

```ts
import type { InferCreate, InferUpdate } from "@qala/core";

type NewTask = InferCreate<typeof Task>;   // { title: string; projectId: string; id?; done?; priority?; note?; parentId?; createdAt? }
type TaskPatch = InferUpdate<typeof Task>; // every field optional, no `id`
```

On insert, a field is optional when it has a default, is the primary key, or accepts NULL. The same rules exist at run
time as schemas:

```ts
validate(Task.createSchema, input); // what POST /tasks accepts
validate(Task.updateSchema, input); // what PATCH /tasks/:id accepts
```

`resource()` uses them automatically. In your own services, type inputs with `InferCreate` and pass them to
`db.table(Task).insert(...)` — the table itself accepts any partial row and lets the database fill defaults.

A model that declares no defaults (written before modifiers existed) keeps `InferCreate = Partial<Row>`.

## Options

```ts
export const Task = model("tasks", shape, {
  primaryKey: "code",                                 // when the key is not `id` and not marked `.primary()`
  audit: true,                                        // record changes as activity (see Events)
  realtime: (task) => ({ projectId: task.projectId }), // publish changes to that scope (see Events)
  events: true,                                       // Task.created / updated / deleted
});
```

## Before / after

Before, a model, a hand-written migration and two validation schemas said the same thing four times:

```ts
export const Task = model("tasks", { id: t.uuid(), title: t.string(), done: t.boolean(), createdAt: t.datetime() });
export const NewTask = t.object({ title: t.string(), done: t.optional(t.boolean()) });
export const TaskChanges = t.object({ title: t.optional(t.string()), done: t.optional(t.boolean()) });
// + database/migrations/0001_create_tasks.sql written by hand
```

Now the model says it once; `Task.createSchema`, `Task.updateSchema` and `qala migrate:make` follow from it.

## Native builds

Everything here compiles with `scriptc --node-islands=off`. `qala generate` writes a typed decoder for every model
(also for fields with modifiers), so rows are decoded with static shapes.
