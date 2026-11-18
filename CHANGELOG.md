# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); Qala uses [semantic versioning](https://semver.org) and, while 0.x, minor versions may break APIs.

## Unreleased

### Added
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
- `qala build` deletes the LLVM IR (`main.ll`, tens of MB) scriptc leaves next to the binary; `--keep-ir` keeps it.
- Docs: the example binary is ~5 MB (the ~3 MB figure predates WebSockets, streaming and CRDT); clang is listed as a requirement.
- scriptc 0.4.13 → 0.4.14 (no framework changes needed; unit, native and Bun end-to-end suites pass).

## 0.1.0

First public version: controllers, DI, models, query compiler ORM, own PostgreSQL client, multi-core serving, middleware, streaming/SSE, WebSockets, multipart, cookies, LISTEN/NOTIFY, SMTP, Argon2id passwords, `@qala/client`, `@qala/crdt`, and native builds with scriptc.
