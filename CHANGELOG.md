# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); Qala uses [semantic versioning](https://semver.org) and, while 0.x, minor versions may break APIs.

## Unreleased

### Added
- `@qala/openapi` and `qala openapi [--out openapi.json] [--yaml]`: an OpenAPI 3.1 document built from the app's routes, `params`/`query`/`body` schemas (as JSON Schema with lengths, bounds, patterns, enums, formats), `auth`, the conventional statuses (201/204/401/403/404/422) and the standard error envelope; `resource()` responses use the model. Hand-written handlers' response bodies are not inferred. Opt in with `"qala": { "openapi": true }` in package.json to have `qala generate` write `.qala/openapi.json`, and `{ "serve": true }` to serve it at `GET /openapi.json` (a pre-generated string, so it works in the native binary). See docs/guide/openapi.md.
- `SchemaNode.rules` (declared min/max, pattern, enum values, array item) and `ControllerDef.resource` (a `resource()`'s model, filters, policy), kept for documentation tools.
- `@qala/jobs` (new package, 0.1.0): a PostgreSQL-backed job queue. `defineJob(name, schema, handler)` declares typed, validated jobs; `jobs.enqueue(job, payload, { delay, queue, maxAttempts, tx })` enqueues, inside a transaction too (outbox: the job and its NOTIFY exist only if the transaction commits). Workers claim with `FOR UPDATE SKIP LOCKED`, run `concurrency` jobs at once, wake on LISTEN/NOTIFY and poll for delayed jobs, retry with exponential backoff, mark jobs dead after `max_attempts` and recover jobs whose lock outlived `visibilityTimeout`. `jobs.start(app)` stops the worker gracefully on `app.shutdown()`. Works in the native binary (tested in CI). Guide: docs/guide/jobs.md.
- `qala make:job <name>` (job file in `app/application/jobs/`) and `qala make:jobs-table [--table]` (migration for the jobs table). `qala check` allows `@qala/jobs` in `app/application`.
- New package `@qala/session`: server-side sessions in PostgreSQL (random 32-byte tokens stored as SHA-256, `__Host-` HttpOnly Secure SameSite=Lax cookie, idle and absolute expiry, token rotation on login, "log out everywhere", background cleanup of expired rows) and `csrf()` middleware (session-bound masked synchronizer token in `x-csrf-token` or `_csrf`, Origin/Sec-Fetch-Site checks, bearer requests exempt, constant-time comparison). Compiles natively with scriptc; see docs/guide/sessions.md.
- Observability: request ids (a valid incoming `x-request-id` is reused, otherwise one is generated; `ctx.requestId`, echoed in the response), `ctx.log` (a per-request logger carrying `request_id`) and `Logger.child()`. `requestLogger` and the 500 "Unhandled error" line now log `request_id`, `method`, `path`, `status` and `duration_ms` (was `ms`). Built-in `GET /health` (liveness) and `GET /ready` (readiness: 503 once shutdown started or when the database does not answer `select 1` within `readyTimeout`); an app route on the same path wins, `health: false` turns them off. New `createApp`/kernel options `health`, `readyTimeout`, `requestId`. The example app's own health controller is gone.
- Production-safe migrations: `migrate()` / `qala migrate` hold a PostgreSQL advisory lock on one pinned connection for the whole run, so two deploys migrating at once serialize instead of racing. Down migrations in a `-- migrate:down` section of the same file; `qala migrate:rollback [--steps N]` (`rollback()`) reverts the newest ones, each in a transaction, and refuses (changing nothing) when one has no down SQL. `qala migrate:status` (`migrationStatus()`). `--lock-timeout` / `--statement-timeout` (`lockTimeout`, `statementTimeout`) for each migration's transaction. `migrate:make` and `make:migration` scaffold a down section. `db.session(fn)` runs `fn` on one pinned connection.
- Graceful shutdown: on SIGTERM/SIGINT the server stops accepting connections, closes WebSockets (1001) and streams, waits up to `shutdownTimeout` (default 10 s) for in-flight requests, runs `onShutdown` hooks (`app.onShutdown()`, or `export function onShutdown(app)` in `app/kernel.ts`), closes the database pool and exits (0 if drained, 1 on timeout). Workers are stopped the same way. `app.shutdown(timeout)` does it from code.
- Request limits in `serve()` options: `headersTimeout` (default 10 s, 408; slowloris protection the native binary did not have), `requestTimeout` (30 s, 408), `keepAliveTimeout` (5 s), `maxHeaderSize` (16 KiB, 431), `wsMaxMessage` (16 MiB, close 1009, now configurable and also applied under Bun). `bodyLimit` (1 MiB, 413) is unchanged.
- PostgreSQL TLS, configured with libpq's `sslmode` (`disable`, `prefer` (default), `require`, `verify-ca`, `verify-full`) and `sslrootcert` in `DATABASE_URL`; `ssl=true` means `require`. Works in the native binary. `Connection.encrypted` tells whether a session is encrypted. CI runs every mode against a TLS-enabled server, and the native end-to-end suite with `verify-full`.
- `qala doctor`: checks Bun, Node.js, platform, scriptc, generated code and database reachability.
- Contribution guide, security policy, issue and PR templates, Renovate config (scriptc bumps get their own PR).
- CI: test coverage report and a PostgreSQL 14–17 matrix.
- CI: `native` job builds `examples/tasks` with scriptc and runs its end-to-end suite against the binary and against Bun.
- `qala doctor` also checks for clang, which scriptc needs to link.
- Deployment guide (Docker, systemd, migrations, production checklist) and a multi-stage distroless Dockerfile for the example app.

- `qala make:test <name>`: an in-process test wired like the real app, from the new generated `.qala/app.gen.ts` (`appOptions`, `setup`).
- `testApp({ setup })` runs a hook on the built app (binds model events).
- Benchmark workflow (weekly, on demand, or PRs labelled `bench`); `bench/run.ts --json --check` fails when native and Bun answer differently or native drops below 80% of Bun's req/s.
- Release process with changesets: a "Version packages" PR, then npm publish and GitHub releases.

### Changed
- The server handles SIGTERM/SIGINT itself (see graceful shutdown); `serve(app, { handleSignals: false })` opts out. `startWorkers()` returns a `Workers` handle with `stop(timeout)` instead of installing its own signal handlers.
- `Pool.close()` (and `Database.close()`) refuse new queries and close connections still in use when they are released.
- `qala build` deletes the LLVM IR (`main.ll`, tens of MB) scriptc leaves next to the binary; `--keep-ir` keeps it.
- Docs: the example binary is ~5 MB (the ~3 MB figure predates WebSockets, streaming and CRDT); clang is listed as a requirement.
- scriptc 0.4.13 → 0.4.14 → 0.4.16 (no framework changes needed; unit, native and Bun end-to-end suites pass). 0.4.15 is skipped: its npm runtime packs were incompatible with the CLI.

### Fixed
- A `resource()` in a `controllers/(auth)/` folder lost its name (404s said "Not found" instead of "Label not found"): `ControllerDef.withAuth()` now keeps it.

## 0.1.0

First public version: controllers, DI, models, query compiler ORM, own PostgreSQL client, multi-core serving, middleware, streaming/SSE, WebSockets, multipart, cookies, LISTEN/NOTIFY, SMTP, Argon2id passwords, `@qala/client`, `@qala/crdt`, and native builds with scriptc.
