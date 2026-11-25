# Qala: notes for coding agents working on the framework

Qala is a TypeScript backend framework compiled to a native binary by [scriptc](https://scriptc.dev). Bun runs it in development and tests; **the native binary is the product**. Human guide: [CONTRIBUTING.md](CONTRIBUTING.md). Apps get their own AGENTS.md from `qala new` (template: `packages/cli/src/agents.ts`).

## Map

- `packages/core/src` the framework (`@qala/core`): HTTP, router, DI container, models, PostgreSQL client, ORM query compiler. Compiled by scriptc as part of every app.
- `packages/cli/src` the `qala` CLI (Bun only, never compiled natively): `bin.ts` commands, `scan.ts` controller scanning, `codegen.ts`/`di.ts` generated code, `check.ts` layer rules, `fix.ts` scriptc rewrites, `diagnostics.ts` codes and `--json` shapes, `scaffold.ts` `qala new`.
- `packages/client`, `packages/crdt` client and CRDT packages.
- `examples/tasks` the reference app; its e2e suite runs against the native binary.
- `docs/` VitePress site (also published as llms.txt); `docs/guide/*.md` per topic.

## Commands

```sh
bun install
bun run typecheck
QALA_TEST_DATABASE_URL=postgres://qala:qala@localhost:5432/qala_test bun test packages   # needs PostgreSQL
cd examples/tasks
bun ../../packages/cli/src/bin.ts generate
DATABASE_URL=postgres://qala:qala@localhost:5432/qala_example bun test test               # builds and tests the native binary
E2E_TARGET=bun DATABASE_URL=... bun test test                                              # same suite on Bun
```

`bun ../../packages/cli/src/bin.ts doctor` checks Bun, Node.js, scriptc, clang and the database.

## Rules

- **Everything in `packages/core` must compile with scriptc** (read [docs/guide/native.md](docs/guide/native.md)): named imports/exports only, no `export default`, no dynamic `import()`, no `any`-shaped data on hot paths, non-async overrides of abstract methods, narrow before casting into a union (scriptc SC2003), default parameters only on class methods, runtime values non-generic (phantom types). Prove it with the native e2e suite above, not only `bun test`.
- Every feature or fix comes with a test; bugs get a regression test that fails before the fix.
- Behaviour or API changes: update `docs/`, add a changeset in `.changeset/` (frontmatter `"@qala/core": patch|minor`, one line for users) and a line under `## Unreleased` in CHANGELOG.md.
- New `qala check` diagnostics get a stable code in `packages/cli/src/diagnostics.ts` and a row in docs/guide/check.md. `--json` shapes only grow; never rename or remove a field without bumping `JSON_VERSION`.
- Error messages name the file and the fix.
- Conventional Commits: `feat(cli): …`, `fix(core): …`, `docs: …`. PRs follow `.github/pull_request_template.md`.
- Do not edit generated `.qala/` folders; regenerate them.
