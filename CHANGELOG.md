# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); Qala uses [semantic versioning](https://semver.org) and, while 0.x, minor versions may break APIs.

## Unreleased

### Added
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

## 0.1.0

First public version: controllers, DI, models, query compiler ORM, own PostgreSQL client, multi-core serving, middleware, streaming/SSE, WebSockets, multipart, cookies, LISTEN/NOTIFY, SMTP, Argon2id passwords, `@qala/client`, `@qala/crdt`, and native builds with scriptc.
