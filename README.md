# Qala

**A structured TypeScript backend framework that compiles to a native binary.**

Qala gives you the shape of Laravel or ASP.NET Core — controllers, dependency injection, models, migrations, middleware, a global error handler, a CLI that generates code — with end-to-end type safety to the frontend like Elysia's Eden, and it builds your app with [scriptc](https://scriptc.dev) into a small native executable that runs **without Node.js or Bun**.

```ts
// app/http/controllers/tasks.controller.ts  →  routes are registered from the file name
export const TasksController = controller({ tasks: TaskService }, ({ tasks }) => ({
  index:   action({ query: { done: t.optional(t.boolean()) } }, ({ query }) => tasks.list(query)),
  show:    action({ params: { id: t.uuid() } }, ({ params }) => tasks.get(params.id)),
  store:   action({ body: CreateTask }, async ({ body }) => created(await tasks.create(body))),
  destroy: action({ params: { id: t.uuid() } }, async ({ params }) => { await tasks.remove(params.id); return noContent(); }),
  complete: post("/:id/complete", { params: { id: t.uuid() } }, ({ params }) => tasks.complete(params.id)),
}));
```

```ts
// in the frontend: fully typed, no code generation step to run by hand
const api = createClient<Api>({ baseUrl: "/api", manifest });
const task = await api.tasks.show({ params: { id } });   // task: { id: string; title: string; done: boolean; ... }
await api.tasks.store({ body: { title: 1 } });            // ✗ type error: title must be a string
```

```
$ qala build
✓ 15 files follow the dependency rule (domain ← application ← infrastructure/http).
✓ dist/app  2.87 MB  10 routes  5.8s  (native, no Node.js runtime)
$ ldd dist/app
        libc.so.6 => /usr/lib/libc.so.6
```

## Why

- **Native and small.** The whole app — HTTP server, router, validation, the PostgreSQL driver — is plain TypeScript inside scriptc's static subset, so it compiles to one ~3 MB machine-code binary. Idle memory is ~5 MB instead of ~55 MB, startup is ~7 ms instead of ~170 ms, and it outperforms the same code on Bun in every measured scenario — see [Performance](#performance). The same code also runs on Bun for development.
- **Organised by default.** Folders are layers and the builder enforces the dependency rule (`qala check`): domain depends on nothing, HTTP never reaches into infrastructure. Your codebase stays readable as it grows.
- **Short code.** A route is one line. Validation, status codes, error responses and wiring are conventions, not boilerplate.
- **Types end to end.** The request schemas and the handler's return type flow to the frontend client. Rename a field on the server and the frontend fails to compile.

## Features

| | |
|---|---|
| Routing | Controllers are discovered by file name; `index/show/store/update/destroy` map to REST routes automatically; `get/post/put/patch/del` for anything else; 404/405 handled |
| Validation | `t.string/number/integer/boolean/uuid/email/datetime/enum/array/object/optional/nullable`, every issue reported at once (422), query strings coerced |
| Errors | One global handler: `HttpError` family (`NotFoundError`, `ConflictError`, …) → status codes, `DomainError` → 422, unknown → 500 + log; optional `onError` hook |
| Dependency injection | Class tokens like .NET (`singleton(TaskRepository, c => new PgTaskRepository(c.get(Database)))`), abstract classes as interfaces |
| Models & database | Own PostgreSQL client (SCRAM auth, pool, transactions), `model()` definitions with inferred row types, typed repositories (`db.table(Task).all({ where, orderBy, limit })`, `whereRaw`), generated typed row decoders, raw SQL, migrations |
| Middleware | Global (`app/kernel.ts`) or per controller; `cors`, `requestLogger`, `securityHeaders`, `rateLimit` included |
| Config | `defineConfig(env => ({ port: env.number("PORT", 3000) }))`, `.env` loading, all missing variables reported at startup |
| Client | `@qala/client`: typed calls, `ApiError` with server details, custom transport (in-process testing) |
| CLI | `qala new / dev / build / start / generate / routes / check / migrate / make:*` |

## Quick start

Requirements: [Bun](https://bun.sh) ≥ 1.3, Node.js ≥ 24 (only to install scriptc), PostgreSQL, Linux or macOS. The packages are not on npm yet; use the repository:

```sh
git clone https://github.com/Prestgg1/qala && cd qala && bun install
alias qala="bun $PWD/packages/cli/src/bin.ts"

qala new ../my-api --core $PWD/packages/core/src/index.ts
cd ../my-api && bun install
qala make:model task
qala make:repository task      # abstract repository in domain + Postgres implementation
qala make:service task
qala make:controller tasks --resource
qala make:migration create_tasks
qala migrate
qala dev                       # Bun, hot reload
qala build && qala start       # native binary
```

## Project layout

```
app/
  domain/            entities, models, value objects, repository interfaces, domain errors
  application/       services / use cases (depend on domain only)
  infrastructure/    repository implementations, external services
  http/
    controllers/     tasks.controller.ts → /tasks, admin/users.controller.ts → /admin/users
    middleware/
  providers.ts       composition root: which implementation serves which abstraction
  kernel.ts          global middleware and error handling
config/app.ts        typed configuration
database/migrations/ 0001_create_tasks.sql, ...
.qala/               generated by the builder (routes, entry point, frontend API types)
```

`qala check` enforces:

| layer | may import |
|---|---|
| `domain` | domain, `@qala/core` |
| `application` | application, domain, `@qala/core` |
| `infrastructure` | infrastructure, application, domain, any package |
| `http` | http, application, domain, `@qala/core` — never infrastructure |
| `providers.ts`, `kernel.ts`, `config` | anything (composition roots) |

## A tour

### Models

```ts
// app/domain/task.ts
export const Task = model("tasks", {
  id: t.uuid(),
  title: t.string({ min: 1, max: 200 }),
  done: t.boolean(),
  dueAt: t.nullable(t.datetime()),
  createdAt: t.datetime(),
});
export type Task = InferModel<typeof Task>;   // { id: string; title: string; done: boolean; dueAt: string | null; createdAt: string }
```

Fields are camelCase in TypeScript and snake_case in the database.

### Repositories and services

```ts
// app/domain/task.repository.ts
export abstract class TaskRepository {
  abstract all(done?: boolean): Promise<Task[]>;
  abstract find(id: string): Promise<Task | null>;
}

// app/infrastructure/pg-task.repository.ts
export class PgTaskRepository extends TaskRepository {
  constructor(private readonly db: Database) { super(); }
  all(done?: boolean) { return this.db.table(Task).all({ where: done === undefined ? {} : { done }, orderBy: ["createdAt", "desc"] }); }
  find(id: string) { return this.db.table(Task).find(id); }
}

// app/providers.ts
export const providers = [
  singleton(Database, () => new Database(config.databaseUrl)),
  singleton(TaskRepository, (c) => new PgTaskRepository(c.get(Database))),
  singleton(TaskService, (c) => new TaskService(c.get(TaskRepository))),
];
```

### Errors

Throw from anywhere; the response is always the same shape:

```ts
throw new NotFoundError("Task not found");
// 404 {"error":{"status":404,"code":"not_found","message":"Task not found","details":null}}
```

Validation failures list every problem:

```json
{"error":{"status":422,"code":"validation_failed","message":"Invalid body",
  "details":[{"path":"title","message":"must be at least 1 characters"},{"path":"tags[0]","message":"expected string, got number"}]}}
```

### Middleware

```ts
// app/http/middleware/auth.ts — layers never import config; the composition root passes values in
export function bearerAuth(token: string): Middleware {
  return async (ctx, next) => {
    if (ctx.bearer() !== token) throw new UnauthorizedError();
    return next();
  };
}

// app/kernel.ts — global middleware; or pass { middleware: [...] } as controller()'s third argument
export const kernel = { middleware: [requestLogger(logger), cors(), bearerAuth(config.apiToken)] };
```

### Typed client

`qala generate` (also run by `dev` and `build`) writes `.qala/api.ts` with the `Api` type and a route manifest. The frontend imports both:

```ts
import { createClient, ApiError } from "@qala/client";
import { manifest, type Api } from "../server/.qala/api";

const api = createClient<Api>({ baseUrl: "https://api.example.com", manifest, headers: () => ({ authorization: `Bearer ${token}` }) });
try {
  const tasks = await api.tasks.index({ query: { done: false } });
} catch (e) {
  if (e instanceof ApiError && e.status === 422) showErrors(e.details);
}
```

For tests, pass a `transport` that calls `app.handle(...)` in-process.

## How the native build works

`qala build` runs the architecture check, generates `.qala/main.ts` (static imports of every controller — scriptc has no dynamic imports) and calls `scriptc build --node-islands=off`, which fails the build if anything would need Node.js. The framework is consumed as TypeScript source through `tsconfig` `paths`, so scriptc compiles it together with your code.

Writing code for scriptc mostly means writing ordinary, well-typed TypeScript. See [docs/scriptc.md](docs/scriptc.md) for the rules the framework follows and what to avoid in app code (default exports, `any`-shaped data, dynamic code).

## Performance

The [example app](examples/tasks) measured as a native binary (`--optimization speed`) and on Bun: same code, byte-identical responses, PostgreSQL on the same 4-core machine, server pinned to 3 cores, load generator on the 4th, 10 s per scenario, 50 connections. One busy desktop (load ~5–7), single runs — treat differences under ~30% as noise.

| | native | Bun |
|---|---|---|
| startup | 7 ms | 173 ms |
| memory idle / peak | 5 MB / 8 MB | 58 MB / 148 MB |
| binary size | ~3 MB, links only libc | — |
| `GET /tasks?limit=50` | **4 807 req/s** (p99 22 ms) | 3 348 req/s (p99 32 ms) |
| `GET /tasks/:id` | **9 158 req/s** (p99 11 ms) | 5 888 req/s (p99 35 ms) |
| `GET /tasks?q=` (ILIKE search) | **2 964 req/s** (p99 29 ms) | 1 454 req/s (p99 180 ms) |
| `POST /comments` (write + auth) | 406 req/s | 382 req/s |

Why it is fast: `qala generate` writes a typed row decoder for every model (`.qala/models.gen.ts`), rows come off the wire as text arrays and are decoded straight into their static shape, timestamps are converted with string operations instead of `Date`, and each action serialises its result inside a generic wrapper, so `JSON.stringify` is compiled for the real type. Before these changes a 50-row list ran at 1 277 req/s natively — the same code walked untyped records in scriptc's dynamic tier.

## Packages

| package | what |
|---|---|
| [`@qala/core`](packages/core) | runtime: HTTP, routing, validation, DI, errors, middleware, config, PostgreSQL, models, migrations |
| [`@qala/client`](packages/client) | typed frontend client |
| [`@qala/cli`](packages/cli) | the builder: code generation, architecture check, scaffolding, native builds |

## Status

Qala is young (0.1). scriptc itself is experimental. The PostgreSQL client covers what the framework needs (no TLS yet, text protocol, common types). Feedback and pull requests are welcome.

## License

MIT
