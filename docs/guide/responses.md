# Responses

Return what you have. Qala picks the status code.

| the handler returns | response |
|---|---|
| a value | `200` with the value as JSON |
| a value, from a conventional `store` | `201` |
| `undefined` (or nothing) | `204 No Content` |
| `null` | `404` — `"Task not found"` when the controller is a resource |
| a `Reply` (`json`, `created`, `noContent`, `text`, `redirect`) | exactly that reply |

```ts
export const TasksController = controller({ tasks: TaskService }, ({ tasks }) => ({
  show:    action({}, ({ id }) => tasks.find(id)),            // Task | null → 200 or 404
  store:   action({ body: NewTask }, ({ body }) => tasks.create(body)),   // → 201
  destroy: action({}, async ({ id }) => { await tasks.remove(id); }),     // → 204
}));
```

Before, the same controller needed `findOrFail`, `created(...)` and `noContent()`:

```ts
show:    action({ params: { id: t.uuid() } }, ({ params }) => tasks.findOrFail(params.id)),
store:   action({ body: NewTask }, async ({ body }) => created(await tasks.create(body))),
destroy: action({ params: { id: t.uuid() } }, async ({ params }) => { await tasks.remove(params.id); return noContent(); }),
```

## `id`

Every handler receives `id`: the `:id` route parameter as a string (`""` on routes without one).
Declare `params: { id: t.uuid() }` when you want it validated; a resource controller validates it against the
model's primary key for you.

## The typed client

A `null` never reaches the client — it is a 404 — so `ResultOf` drops it: `show` above is typed `Task`,
and a missing task rejects with `ApiError` (`status: 404`).

## Explicit replies

A `Reply` is sent as it is, also from `store`:

```ts
store: action({ body: NewTask }, async ({ body }) => json(await tasks.create(body), 200)),  // stays 200
```
