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
✓ dist/app  4.86 MB  10 routes  8.3s  (native, no Node.js runtime)
$ ldd dist/app
        libc.so.6 => /usr/lib/libc.so.6
```

## Why

- **Native and small.** The whole app — HTTP server, router, validation, the PostgreSQL driver — is plain TypeScript inside scriptc's static subset, so it compiles to one ~5 MB machine-code binary. Idle memory is ~5 MB instead of ~55 MB, startup is ~7 ms instead of ~170 ms, and it outperforms the same code on Bun in every measured scenario — see [Performance](#performance). The same code also runs on Bun for development.
- **Organised by default.** Folders are layers and the builder enforces the dependency rule (`qala check`): domain depends on nothing, HTTP never reaches into infrastructure. Your codebase stays readable as it grows.
- **Short code.** A route is one line. Validation, status codes, error responses and wiring are conventions, not boilerplate.
- **Types end to end.** The request schemas and the handler's return type flow to the frontend client. Rename a field on the server and the frontend fails to compile.

## How short is Qala code?

The [example app](examples/tasks) (tasks + comments, auth, validation, domain rules, search, Clean Architecture) was
rewritten when the conventions below landed; same HTTP API, same end-to-end tests:

| | before | after |
|---|---|---|
| files (app, config, migrations) | 17 | 13 |
| lines (no blanks or comments) | 277 | 190 (−31%) |
| providers / wiring | 15 lines | 0 (generated) |
| repositories (contracts + Postgres classes) | 4 files, 69 lines | 1 query + 1 class, 19 lines |

<table><tr><th>before</th><th>after</th></tr><tr><td>

```ts
export const TasksController = controller(
  { tasks: TaskService }, ({ tasks }) => ({
  show: action({ params: id },
    ({ params }) => tasks.get(params.id)),   // get() throws 404
  store: action({ body: NewTask },
    async ({ body }) => created(await tasks.create(body))),
  destroy: action({ params: id }, async ({ params }) => {
    await tasks.remove(params.id);
    return noContent();
  }),
}));
// + app/providers.ts, a repository contract,
//   a Postgres repository, a write-guard middleware
```

</td><td>

```ts
export class TasksController {
  constructor(private tasks: TaskService) {}

  show = action({ params },
    ({ id }) => this.tasks.get(id));        // null → 404
  store = action({ body: NewTask, auth: true },
    ({ body }) => this.tasks.create(body)); // → 201
  destroy = action({ params, auth: true },
    ({ id }) => this.tasks.remove(id));     // → 204
}
// DI, Database (from DATABASE_URL), auth types and
// env are generated; search is one typed query
```

</td></tr></table>

What does the work: dependency injection generated from constructor types, `Database` provided from `DATABASE_URL`,
response conventions (`undefined` → 204, `null` → 404, `store` → 201), `auth: true` with a typed `user` from
`app/auth.ts`, declarative `errors({...})`, models that carry their own constraints, `query(($) => …)` with inferred
parameter types, `resource(Model)` for plain CRUD, and a typed `env` from `.env.example`.

## Features

| | |
|---|---|
| Routing | Controllers are discovered by file name; `index/show/store/update/destroy` map to REST routes automatically; `get/post/put/patch/del` for anything else; 404/405 handled |
| Validation | `t.string/number/integer/boolean/uuid/email/datetime/enum/array/object/optional/nullable`, every issue reported at once (422), query strings coerced |
| Errors | One global handler: `HttpError` family (`NotFoundError`, `ConflictError`, …) → status codes, `DomainError` → 422, unknown → 500 + log; optional `onError` hook |
| Dependency injection | Class tokens like .NET (`singleton(TaskRepository, c => new PgTaskRepository(c.get(Database)))`), abstract classes as interfaces |
| Models & database | Own PostgreSQL client (SCRAM auth, pool, transactions), `model()` definitions with inferred row types, typed repositories (`db.table(Task).all({ where, orderBy, limit })`, `whereRaw`), generated typed row decoders, raw SQL, migrations |
| Query compiler (ORM) | Queries declared with a typed builder are compiled by `qala generate` into SQL, prepared statements and generated decoders; relations load without N+1 (one statement per level, all pipelined in one round trip); `batch()` runs independent queries in one round trip — see [docs/orm.md](docs/orm.md) |
| PostgreSQL client | Automatic prepared statements (per-connection LRU), pipelining, transactions; `qala db:pull` generates models from an existing database |
| Multi-core | `serve(app, { workers: "auto" })`: one process per core on the same port (SO_REUSEPORT), crash restart, signal forwarding |
| Middleware | Global (`app/kernel.ts`) or per controller; `cors`, `requestLogger`, `securityHeaders`, `rateLimit` included |
| Config | `defineConfig(env => ({ port: env.number("PORT", 3000) }))`, `.env` loading, all missing variables reported at startup |
| Client | `@qala/client`: typed calls, `ApiError` with server details, custom transport (in-process testing) |
| CLI | `qala new / dev / build / start / generate / routes / check / migrate / db:pull / make:*` |

## Quick start

Requirements: [Bun](https://bun.sh) ≥ 1.3, Node.js ≥ 24 (only to install scriptc), clang (scriptc links with it), PostgreSQL, Linux or macOS. The packages are not on npm yet; use the repository:

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

### Streaming and WebSockets

Server-sent events and streamed bodies are ordinary handler results; the connection stays open until the handler
closes it or the client goes away:

```ts
events: get("/events", {}, ({ ctx }) =>
  sse(ctx, (events) => {
    events.send({ id: 1, event: "hello", data: JSON.stringify({ ok: true }) });
    const heartbeat = setInterval(() => events.comment("ping"), 8000);   // heartbeats are the app's job
    events.onClose(() => clearInterval(heartbeat));                       // close() or client disconnect
  }),
),
export: get("/export", {}, ({ ctx }) => stream(ctx, (out) => { out.write("id,title\n"); out.close(); }, { contentType: "text/csv" })),
```

WebSocket routes live in controllers too. The upgrade request runs through the global and the controller's middleware
(auth, CORS) like any request, so a rejected upgrade gets the usual error response (e.g. 401); a plain GET to the path is 426.

```ts
export const DocsController = controller({ rooms: Rooms }, ({ rooms }) => ({
  live: ws("/:id/live", {
    open: (socket, ctx) => rooms.join(ctx.params["id"] ?? "", socket),
    message: (socket, data) => rooms.receive(socket, data),   // string (text frame) or Uint8Array (binary)
    close: (socket, code) => rooms.leave(socket),
  }),
}), { middleware: [isAuth] });
```

The WebSocket protocol (RFC 6455 handshake, masking, fragmentation, ping/pong, close, 64-bit lengths) is implemented in
Qala itself over node:http's `upgrade`, so it compiles into the native binary. Under Bun, `serve()` runs on `Bun.serve`
(with Bun's WebSocket support behind the same `WsSocket` API), because Bun's node:http neither hands over upgraded sockets
nor reports a client that leaves a streamed response.

### Startup hook

`app/kernel.ts` may export `onStart(app, { primary })`. The generated entry calls it once per process after the server is listening; `primary` is false in worker processes, so once-per-deployment work (schedulers, LISTEN bridges you only need once) can be limited to the primary:

```ts
export function onStart(app: App, process: { primary: boolean }): void {
  app.container.get(RealtimeBus).start();          // every process
  if (process.primary) app.container.get(Jobs).start(); // once
}
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

Writing code for scriptc mostly means writing ordinary, well-typed TypeScript. See [docs/guide/native.md](docs/guide/native.md) for the rules the framework follows and what to avoid in app code (default exports, `any`-shaped data, dynamic code).

## Performance

The [example app](examples/tasks) measured as a native binary (`--optimization speed`) and on Bun: same code, byte-identical responses, PostgreSQL on the same 4-core machine, server pinned to 3 cores, load generator on the 4th, 10 s per scenario, 50 connections. One busy desktop (load ~5–7), single runs — treat differences under ~30% as noise.

| | native | Bun |
|---|---|---|
| startup | 7 ms | 173 ms |
| memory idle / peak | 5 MB / 8 MB | 58 MB / 148 MB |
| binary size | ~5 MB, links only libc and libm | — |
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

Qala is young (0.1). scriptc itself is experimental. The PostgreSQL client covers what the framework needs (TLS with libpq's `sslmode`, text protocol, common types). Feedback and pull requests are welcome.

## Documentation

Full guide: https://prestgg1.github.io/qala/. For language models and coding agents:
[llms.txt](https://prestgg1.github.io/qala/llms.txt) (index) and
[llms-full.txt](https://prestgg1.github.io/qala/llms-full.txt) (everything in one file).

## License

MIT
