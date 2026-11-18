# Contributing to Qala

## Setup

```sh
git clone https://github.com/Prestgg1/qala && cd qala && bun install
alias qala="bun $PWD/packages/cli/src/bin.ts"
qala doctor
```

Tests need PostgreSQL. The quickest way:

```sh
docker run -d --name qala-pg -e POSTGRES_USER=qala -e POSTGRES_PASSWORD=qala -e POSTGRES_DB=qala_test -p 5432:5432 postgres:17-alpine
bun run typecheck && bun test packages
```

## Rules of thumb

- **Everything in `@qala/core` must compile with scriptc.** It runs on Bun too, but the native binary is the product. Read [docs/guide/native.md](docs/guide/native.md) before changing core: no dynamic imports, no default exports, no `any`-shaped data on hot paths.
- Check native changes with the example app: `cd examples/tasks && qala build && qala start`.
- Every feature or fix comes with a test. Bugs get a regression test that fails before the fix.
- Public API changes need a docs update in `docs/` and a changeset: run `bunx changeset`, pick the bump, write one line for users. Releases are cut from changesets automatically (see `.changeset/README.md`).
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org): `feat(orm): …`, `fix: …`, `docs: …`, `perf: …`.

## scriptc upgrades

Renovate opens a PR for every scriptc release. Before merging: read the scriptc changelog, run the native build of `examples/tasks` and its end-to-end tests, and add a changeset for any framework change. Add the `bench` label to the PR to run the native-vs-Bun benchmark.
