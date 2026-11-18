---
title: Getting started
---

# Getting started


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

Next: [Project layout](./project-layout), then [Controllers](./controllers).

## Testing

`qala make:test tasks` writes `test/tasks.test.ts`: an in-process app wired exactly like the real one (from the generated `.qala/app.gen.ts`) with a typed client, run by `bun test`. See [Testing](./testing).

## Checking your setup

`qala doctor` checks everything Qala needs and tells you how to fix what is missing:

```sh
$ qala doctor
✓ Bun             1.3.2
✓ Node.js         v24.2.0
✓ Platform        linux
✓ scriptc         0.4.13
✓ Project         /home/me/my-api
✓ Generated code  .qala/ present
✗ Database        localhost:5432 unreachable
                  → is PostgreSQL running?
```

It exits with 1 when a check fails, so it can run in CI. Include its output in bug reports.

## For LLMs and coding agents

The docs are also published as plain text for language models:

- [`/llms.txt`](https://prestgg1.github.io/qala/llms.txt): an index of every page with links.
- [`/llms-full.txt`](https://prestgg1.github.io/qala/llms-full.txt): the whole documentation in one file, ready to paste into a prompt.
- Any page as Markdown: add `.md` to its URL, e.g. [`/guide/resources.md`](https://prestgg1.github.io/qala/guide/resources.md).
