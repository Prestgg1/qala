---
title: What is Qala
---

# What is Qala

**A structured TypeScript backend framework that compiles to a native binary.**

Qala gives you the shape of Laravel or ASP.NET Core: controllers, dependency injection, models, migrations, middleware, a global error handler and a CLI that generates code. It adds end-to-end type safety to the frontend, like Elysia's Eden, and builds your app with [scriptc](https://scriptc.dev) into a small native executable that runs **without Node.js or Bun**.

```
$ qala build
✓ 15 files follow the dependency rule (domain ← application ← infrastructure/http).
✓ dist/app  4.86 MB  10 routes  8.3s  (native, no Node.js runtime)
$ ldd dist/app
        libc.so.6 => /usr/lib/libc.so.6
```

## Why


- **Native and small.** The whole app — HTTP server, router, validation, the PostgreSQL driver — is plain TypeScript inside scriptc's static subset, so it compiles to one ~5 MB machine-code binary. Idle memory is ~5 MB instead of ~55 MB, startup is ~7 ms instead of ~170 ms, and it outperforms the same code on Bun in every measured scenario — see [Performance](./performance). The same code also runs on Bun for development.
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
| Query compiler (ORM) | Queries declared with a typed builder are compiled by `qala generate` into SQL, prepared statements and generated decoders; relations load without N+1 (one statement per level, all pipelined in one round trip); `batch()` runs independent queries in one round trip — see [docs/orm.md](./queries) |
| PostgreSQL client | Automatic prepared statements (per-connection LRU), pipelining, transactions; `qala db:pull` generates models from an existing database |
| Multi-core | `serve(app, { workers: "auto" })`: one process per core on the same port (SO_REUSEPORT), crash restart, signal forwarding |
| Middleware | Global (`app/kernel.ts`) or per controller; `cors`, `requestLogger`, `securityHeaders`, `rateLimit` included |
| Config | `defineConfig(env => ({ port: env.number("PORT", 3000) }))`, `.env` loading, all missing variables reported at startup |
| Client | `@qala/client`: typed calls, `ApiError` with server details, custom transport (in-process testing) |
| CLI | `qala new / dev / build / start / generate / routes / check / migrate / db:pull / make:*` |

## Packages


| package | what |
|---|---|
| [`@qala/core`](https://github.com/Prestgg1/qala/tree/main/packages/core) | runtime: HTTP, routing, validation, DI, errors, middleware, config, PostgreSQL, models, migrations |
| [`@qala/client`](https://github.com/Prestgg1/qala/tree/main/packages/client) | typed frontend client |
| [`@qala/cli`](https://github.com/Prestgg1/qala/tree/main/packages/cli) | the builder: code generation, architecture check, scaffolding, native builds |

## Status


Qala is young (0.1). scriptc itself is experimental. The PostgreSQL client covers what the framework needs (no TLS yet, text protocol, common types). Feedback and pull requests are welcome.

## Next

- [Getting started](./getting-started) to scaffold an app.
- [Project layout](./project-layout) to see how an app is organised.
