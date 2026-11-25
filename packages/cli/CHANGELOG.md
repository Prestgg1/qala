# @qala/cli

## 1.0.0

### Minor Changes

- efaeba0: Agent-friendly projects: `qala new` writes `AGENTS.md` and `CLAUDE.md`; `qala check --json`, `qala routes --json` and `qala doctor --json` print stable, versioned JSON; `qala check` diagnostics have stable codes (`QALA101`…`QALA207`) with a fix hint and docs link; a failed native build explains the usual causes; common runtime errors (missing provider, missing env variables, missing `authenticate`, bad `resource()` option) name the file and the fix.
- d502e84: `qala doctor`, `qala make:test` with a generated `.qala/app.gen.ts`, `testApp({ setup })`, and `qala build` now deletes scriptc's LLVM IR (`--keep-ir` keeps it).
- 564e9da: Graceful shutdown and request limits. On SIGTERM/SIGINT `serve()` stops accepting connections, closes WebSockets (1001) and streams, waits up to `shutdownTimeout` for in-flight requests, runs `onShutdown` hooks (`app.onShutdown`, or `export function onShutdown` in `app/kernel.ts`), closes the database pool and exits (0 if drained, 1 on timeout); workers are stopped the same way. New `serve` options: `headersTimeout` (slowloris protection, 408; now enforced in the native binary), `requestTimeout` (408), `keepAliveTimeout`, `maxHeaderSize` (431), `wsMaxMessage` (1009), `shutdownTimeout`, `handleSignals`. Behavior change: the process now handles SIGTERM/SIGINT itself; pass `handleSignals: false` to opt out. `startWorkers` returns a `Workers` handle instead of installing signal handlers.
- 83ba5dc: `qala make:job <name>` scaffolds a `@qala/jobs` job in `app/application/jobs/`; `qala make:jobs-table` writes the migration for the jobs table. `qala check` allows `@qala/jobs` imports in `app/application`.
- 265c322: Production-safe migrations: `migrate()` and `qala migrate` hold a PostgreSQL advisory lock on one connection for the whole run, so concurrent deploys take turns. Down migrations (`-- migrate:down` section in the same file) with `rollback()` / `qala migrate:rollback [--steps N]`, `migrationStatus()` / `qala migrate:status`, `lockTimeout` / `statementTimeout` options (`--lock-timeout`, `--statement-timeout`), and `db.session()` to pin a connection. `migrate:make` and `make:migration` scaffold a down section.
- 1fa3ef7: Observability: request ids (`x-request-id` reused when valid, otherwise generated; `ctx.requestId`; echoed in the response), `ctx.log` per-request logger and `Logger.child()`, `requestLogger` / 500 log lines with `request_id`, `method`, `path`, `status`, `duration_ms` (the `ms` field is renamed), and built-in `GET /health` and `GET /ready` (503 while shutting down or when the database does not answer). New `createApp` options `health`, `readyTimeout` and `requestId`, also read from `app/kernel.ts` by the generated main. Behavior change: `/health` and `/ready` now answer by default unless the app defines them; pass `health: false` to opt out.
- fea7614: New `@qala/openapi` package and `qala openapi [--out file] [--yaml]`: an OpenAPI 3.1 document from the app's routes, input schemas, auth and `resource()` models. `"qala": { "openapi": { "serve": true } }` in package.json makes `qala generate` write `.qala/openapi.json` and serve it at `GET /openapi.json` (natively too). Core schemas now keep their declared rules (`SchemaNode.rules`) and `resource()` controllers their model (`ControllerDef.resource`) for documentation.

### Patch Changes

- a5839b5: scriptc 0.4.14 → 0.4.16 (0.4.15's npm runtime packs were broken, so it is skipped). No framework changes needed: unit, native end-to-end, native lifecycle and Bun suites pass.
- Updated dependencies [fea7614]
  - @qala/openapi@1.0.0
