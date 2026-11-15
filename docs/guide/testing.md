# Testing

`@qala/core/testing` (Bun only; it is not part of the native binary) builds your app in-process and gives you the same typed client the frontend uses. No port, no server.

```ts
// test/tasks.test.ts
import { expect, test } from "bun:test";
import { testApp } from "@qala/core/testing";
import { providers } from "../app/providers";
import { kernel } from "../app/kernel";
import { manifest, type Api } from "../.qala/api";
import { controllers } from "../.qala/routes.gen";

const { client } = testApp<Api>({ controllers, providers, manifest, middleware: kernel.middleware, onError: kernel.onError });

test("creates and reads a task", async () => {
  const task = await client.tasks.store({ body: { title: "write docs" } });
  expect((await client.tasks.show({ params: { id: task.id } })).title).toBe("write docs");
});

test("validation errors are ApiError", async () => {
  await expect(client.tasks.store({ body: { title: "" } })).rejects.toMatchObject({ status: 422 });
});
```

`testApp(options)` takes the same options as `createApp` (the pieces of the generated `.qala/main.ts`), plus:

- `manifest`: from `.qala/api.ts` (defaults to the one derived from the controllers),
- `headers`: sent with every request, e.g. `{ authorization: "Bearer test" }`.

It returns `{ app, client, get }`; `get(TaskService)` resolves a service from the container to arrange or inspect state. Override a provider for a test by listing a later `singleton(...)`/`value(...)` for the same token.

## `withRollback`: tests that leave no trace

```ts
import { withRollback } from "@qala/core/testing";

test("complete marks the task done", () =>
  withRollback(db, async (tx) => {
    const task = await tx.table(Task).insert({ title: "x" });
    await tx.execute("update tasks set done = true where id = $1", [task.id]);
    expect((await tx.table(Task).find(task.id))!.done).toBe(true);
  }));
```

The callback runs inside a transaction that is always rolled back, whether it returns or throws (errors propagate after the rollback). It returns whatever the callback returns. It uses one connection, so it covers code that takes the `tx`; code that uses the pooled `db` inside the test runs outside that transaction.

Run with `bun test`. Add the path once to your `tsconfig` if you copied the monorepo layout: `"@qala/core/testing": ["<core>/src/testing.ts"]`.
