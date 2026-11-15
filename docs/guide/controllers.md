# Controllers

A controller is a file in `app/http/controllers`. Its path is its URL prefix and its actions become routes — there is
no route table to maintain.

```
app/http/controllers/tasks.controller.ts         →  /tasks
app/http/controllers/admin/users.controller.ts   →  /admin/users
app/http/controllers/(auth)/billing.controller.ts →  /billing   (every action requires a signed-in user)
```

## Class controllers

Ask for services in the constructor and declare actions as fields:

```ts
import { action, get, t } from "@qala/core";
import { TaskService } from "../../application/task.service";

export class TasksController {
  constructor(private readonly tasks: TaskService) {}

  index = action({}, () => this.tasks.list());                            // GET    /tasks
  show = action({ params: { id: t.uuid() } }, ({ params }) => this.tasks.get(params.id)); // GET /tasks/:id
  store = action({ body: NewTask }, ({ body }) => this.tasks.create(body)); // POST   /tasks
  overdue = get("/overdue", {}, () => this.tasks.overdue());                 // GET    /tasks/overdue
}
```

- `index`, `show`, `store`, `update`, `destroy` written with `action(...)` get their REST method and path from the name.
- Anything else uses `get/post/put/patch/del/ws("/path", …)`.
- Constructor parameters are injected (see [Dependency injection](./dependency-injection.md)); keep them `private` —
  only public fields holding actions are routes.
- Controller-wide middleware: `static middleware = [rateLimit({ limit: 100, windowMs: 60_000 })];`

The builder reads the class and generates the wiring (`.qala/routes.gen.ts`):

```ts
classController<TasksController>(TasksController, (x) => ({ index: x.index, show: x.show, store: x.store, overdue: x.overdue }))
```

so the native build never walks objects at run time, and the frontend client gets every action's types
(`Api` in `.qala/api.ts`).

## Function controllers

The original form still works and needs no class:

```ts
export const TasksController = controller({ tasks: TaskService }, ({ tasks }) => ({
  index: action({}, () => tasks.list()),
}));
```

Prefer classes in new code: dependencies are written once, in the constructor.

## Route groups and authentication

A folder in parentheses groups files without changing the URL. The `(auth)` group requires authentication for every
action in it: the app's `authenticate` hook in `app/auth.ts` runs first, a `null` user answers 401.

```ts
// app/auth.ts
export type AppUser = { id: string; email: string };
export async function authenticate(ctx: Context): Promise<AppUser | null> {
  const token = ctx.bearer() ?? ctx.cookie("session");
  return token === undefined ? null : sessions.userFor(token);
}
```

The same works per controller with `{ auth: true }` (`controller(deps, build, { auth: true })`).
Other group names (`(admin)`, `(public)`) only organise files.

## Rules the builder enforces

- One controller per file; its export name ends with `Controller`.
- Explicit routes need a string-literal path.
- Two actions resolving to the same method and path fail the build, naming both places.
