# Tasks — the Qala example app

A small task tracker (tasks + comments) that shows every part of [Qala](../../README.md): Clean Architecture
layers, routes generated from controller files, validation, domain rules, global error handling,
models on PostgreSQL, a typed frontend client and a native build with no Node.js inside.

## Run it

You need Bun, PostgreSQL and (for the native build) Node ≥ 24 at install time for scriptc.

```sh
bun install                 # from the repository root
cd examples/tasks
cp .env.example .env        # DATABASE_URL, API_TOKEN, …
createdb qala_example       # or: podman exec <pg> psql -c "create database qala_example"

bun run migrate             # qala migrate: applies database/migrations/*.sql
bun run dev                 # qala dev: generate routes, run on Bun, reload on changes
bun run routes              # qala routes: the route table
bun run check               # qala check: the Clean Architecture dependency rule

bun run build               # qala build: check + generate + scriptc → dist/app (one native binary)
bun run start               # qala start: run dist/app
bun run test                # e2e: migrate, build, start dist/app, drive it with the typed client
E2E_TARGET=bun bun run test # the same suite against `bun .qala/main.ts`
bun run bench               # native vs Bun (needs oha and taskset)
```

```
$ qala routes
POST   /comments            comments.store
DELETE /comments/:id        comments.destroy
GET    /health              health.index
GET    /tasks               tasks.index
GET    /tasks/:id           tasks.show
POST   /tasks               tasks.store
PATCH  /tasks/:id           tasks.update
DELETE /tasks/:id           tasks.destroy
POST   /tasks/:id/complete  tasks.complete
GET    /tasks/:id/comments  tasks.comments
```

Writes need `Authorization: Bearer $API_TOKEN`; reads are public.

## Layout

```
app/
  domain/                    what the business is — no SQL, no HTTP
    task.ts                  Task model (constraints as modifiers), inputs, errors({...}), cleanTitle, TaskSearch contract
    comment.ts               Comment model (references Task)
  application/               use cases; constructor parameters are injected automatically
    task.service.ts          list / get / create / update / complete / remove (null → 404, undefined → 204)
    comment.service.ts
  infrastructure/            what talks to PostgreSQL beyond db.table(...)
    queries/tasks.query.ts   listTasks: query(($) => …), compiled to SQL + a typed decoder at build time
    pg-task-search.ts        TaskSearch on the compiled query (bound automatically: its only implementation)
  http/controllers/
    tasks.controller.ts      → /tasks      (class controller; writes are `auth: true`)
    (auth)/comments.controller.ts → /comments (the (auth) folder makes every action require a user)
    health.controller.ts     → /health
  auth.ts                    authenticate(ctx): the bearer token → AppUser (typed `user` in handlers)
  kernel.ts                  global middleware + error handler (unique violation → 409 "conflict")
.env.example                 typed env: PORT=3000 # type: number … → .qala/env.gen.ts (DATABASE_URL also provides Database)
database/migrations/         0001_create_tasks.sql, 0002_create_comments.sql
web/
  client.ts                  how a frontend calls the API (createClient<Api>)
  types-check.ts             @ts-expect-error proofs of end-to-end type safety
test/e2e.test.ts             end to end against the native binary
bench/run.ts                 native vs Bun benchmark
.qala/                       generated: routes, providers (DI), env, auth types, decoders, queries, api.ts, main.ts
```

No `providers.ts`, no `config/app.ts`, no repository boilerplate: `qala generate` builds the dependency graph from
constructor types, provides `Database` from `DATABASE_URL`, and binds `TaskSearch` to its only implementation.

`qala check` fails the build if a layer imports one it must not (for example a controller importing
`app/infrastructure`), so the dependency direction `domain ← application ← infrastructure / http` holds.

## How much code

The same app before and after Qala's short-code conventions (same HTTP API, same e2e assertions). Lines exclude blanks
and comments:

| | files before | lines before | files after | lines after |
|---|---|---|---|---|
| app/domain | 4 | 73 | 2 | 51 |
| app/application | 2 | 54 | 2 | 54 |
| app/infrastructure | 2 | 54 | 2 | 19 |
| app/http | 4 | 39 | 3 | 30 |
| app/providers.ts | 1 | 15 | 0 | 0 |
| app/auth.ts | 0 | 0 | 1 | 7 |
| app/kernel.ts | 1 | 15 | 1 | 11 |
| config | 1 | 9 | 0 | 0 |
| database/migrations | 2 | 18 | 2 | 18 |
| **total** | **17** | **277** | **13** | **190 (−31%)** |

Where it went: repositories (contracts + Postgres classes, 69 lines) became one compiled query and one small class;
provider wiring and config are generated; `created()`/`noContent()`/404 checks are response conventions; the
write-guard middleware became `auth: true`; `DomainError` subclasses became `errors({...})`.

## End-to-end types

The frontend imports only types and a route manifest from `.qala/api.ts`:

```ts
import { createClient } from "@qala/client";
import { manifest, type Api } from "../.qala/api";

const api = createClient<Api>({ baseUrl, manifest, headers: () => ({ authorization: `Bearer ${token}` }) });
const task = await api.tasks.store({ body: { title: "Write the release notes", priority: 1 } });
//    task: { id: string; title: string; description: string | null; priority: number; done: boolean; dueAt: string | null; createdAt: string }
await api.tasks.complete({ params: { id: task.id } });
await api.tasks.store({ body: { title: "x", priority: "high" } }); // ✗ type error: priority is a number
```

`web/types-check.ts` holds one `@ts-expect-error` per mistake the compiler must catch (wrong body type,
missing field, unknown field, missing or misnamed params, wrong query type, unknown action or controller);
`tsc` fails if any of them stops being an error. (Run `qala generate` before `tsc`: `.qala/` is generated.)

## Benchmark: before vs after the short-code rewrite

Both versions benchmarked back to back with `bun bench/run.ts --speed` (same machine, same session, native binary,
10 s per scenario, 50 connections; responses checked identical to Bun first):

| scenario (native) | before | after |
|---|---|---|
| GET /tasks?limit=50 | 5 725 req/s | 6 434 req/s |
| GET /tasks/:id | 13 680 req/s | 13 393 req/s |
| GET /tasks?q=… (search) | 2 829 req/s | 4 025 req/s |
| POST /comments | 396 req/s | 401 req/s |
| startup / idle RSS / peak RSS | 7 ms / 7 MB / 10 MB | 7 ms / 7 MB / 10 MB |

Shorter code did not cost speed: the search is faster because it is now a compiled, prepared query with a generated
decoder instead of a raw `whereRaw` condition; the rest is within noise.

## Benchmark

`bun bench/run.ts` seeds 1000 tasks, builds `dist/app`, checks that the native binary and `bun .qala/main.ts`
answer the same requests byte for byte, then loads each with `oha` (50 connections, 3 s warm-up, 10 s measured).
Servers run on cores 0–2, `oha` on core 3; PostgreSQL 17 runs in a container on the same machine without pinning.

Machine: 4-core x86-64 laptop, Linux, Bun 1.3.14, scriptc 0.4.13. **Single runs on a busy desktop** (browser
and other builds open; load average 5–7 during the run): treat differences under ~30% as noise.
The write scenario is `POST /comments` (validation, task lookup, insert) because task titles are unique.

Native built with `--optimization speed` (`bun bench/run.ts --speed`), with the generated model decoders:

| | startup | idle RSS | peak RSS under load |
|---|---|---|---|
| native (`dist/app`, ~3 MB) | 7 ms | 5 MB | 8 MB |
| Bun | 173 ms | 58 MB | 148 MB |

| scenario | native req/s | Bun req/s | native p50 / p99 | Bun p50 / p99 |
|---|---|---|---|---|
| GET /tasks?limit=50 (50 rows) | **4 807** | 3 348 | 9.6 / 22.3 ms | 14.0 / 32.4 ms |
| GET /tasks/:id | **9 158** | 5 888 | 5.1 / 10.6 ms | 6.7 / 35.1 ms |
| GET /tasks?q=… (ILIKE) | **2 964** | 1 454 | 16.2 / 28.6 ms | 29.4 / 179.8 ms |
| POST /comments | 406 | 382 | 118.8 / 273.1 ms | 125.0 / 274.6 ms |

Before typed row decoding the native binary lost on large result sets (50 rows: 1 277 req/s vs Bun 2 516):
rows were `Record<string, DbValue>` objects decoded and serialised in scriptc's dynamic tier, and every
timestamp went through `Date`. Three changes fixed it, all in the framework, none in app code:

1. `qala generate` writes `.qala/models.gen.ts`: one typed decoder per model, building each row in its static shape
   from the wire's text values (column order fixed by an explicit select list).
2. `pgIso` converts Postgres `timestamptz` text (the connection runs in UTC) to ISO with string operations.
3. Each action serialises its result inside a generic wrapper, so `JSON.stringify` is compiled for the real type.

Micro-benchmark of the 50-row response path (decode + serialise, native): 86 µs → 18 µs.
