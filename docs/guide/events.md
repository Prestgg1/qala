# Model events

Side effects that follow a write (an activity log row, a realtime message, a notification) are declared
once, next to the model or in `app/events/`, instead of being repeated in every service method.

## Audit and realtime: model options

```ts
// app/domain/task.ts
export const Task = model("tasks", { id: t.uuid().primary(), title: t.string(), projectId: t.uuid() }, {
  audit: true,                                        // every change → the app's AuditSink
  realtime: (task) => ({ projectId: task.projectId }), // every change → the app's RealtimeSink, with this scope
});
```

The app provides the two sinks once (infrastructure):

```ts
// app/infrastructure/activity-log.ts
export class ActivityLog extends AuditSink {
  constructor(private readonly db: Database) { super(); }
  record(change: ModelChange): Promise<void> {
    return this.db.table(Activity).insert({ table: change.table, action: change.kind, data: JSON.stringify(change.row) }).then(() => undefined);
  }
}

// app/infrastructure/live.ts
export class Live extends RealtimeSink {
  constructor(private readonly db: Database) { super(); }
  publish(change: ModelChange, scope: unknown): Promise<void> {
    return this.db.notify("realtime", JSON.stringify({ ...(scope as object), op: change.kind }));
  }
}
```

With automatic DI they are found by their abstract class; nothing else to register.

## Handlers: `on(Model, kind, handler)`

```ts
// app/events/tasks.ts — every file in app/events is imported by the generated entry
import { on } from "@qala/core";
import { Task } from "../domain/task";
import { Notifications } from "../application/notifications";

on(Task, "created", (task, ctx) => ctx.service(Notifications).taskCreated(task));

on(Task, "updated", async (task, before, ctx) => {
  if (task.done && !before.done) await ctx.service(Notifications).taskCompleted(task);
});

on(Task, "deleted", (task) => console.log(`deleted ${task.title}`));
```

- `created` and `deleted` get the row; `updated` gets the row after and before the change.
- `ctx.service(Token)` resolves any service from the app's container; `ctx.change` is the raw change.
- Handlers run in registration order. One that throws is logged; the write and the other handlers are not
  affected.

Before / after:

```ts
// before: in every service that writes a task
const task = await tasks.insert(input);
await activity.record("tasks", "created", task);
await realtime.publish({ projectId: task.projectId, op: "created" });
await notifications.taskCreated(task);

// after
const task = await tasks.insert(input);
```

## When they run

- Events fire for writes through `db.table(Model)`: `insert`, `update`, `delete`.
- Outside a transaction they run right after the statement, before the write call returns.
- Inside `db.transaction(...)` they are held until COMMIT and dropped on ROLLBACK, so nothing is announced
  that did not happen.
- `update` reads the row before the change in the same statement (`UPDATE … FROM (SELECT … FOR UPDATE)`) only
  when an `updated` handler or `audit` needs it; models without handlers or options do no extra work.
- Compiled queries (`run(db, Queries.x, …)`) and raw SQL do not fire events.

## Testing

`resetEvents()` removes every handler; `bindEvents(container)` binds the container handlers and sinks use
(the generated entry does this for the app).
