---
title: Using Qala with AI agents
---

# Using Qala with AI agents

Qala is built to be easy for coding agents (Claude Code, Codex, Cursor, Copilot, …) to work in: one way to lay out an app, generated wiring instead of conventions to remember, a checker with stable codes, and CLI output an agent can parse.

## AGENTS.md

`qala new` writes an `AGENTS.md` into the app, and a `CLAUDE.md` containing just `@AGENTS.md` (Claude Code reads `CLAUDE.md` and follows the import; most other agents read `AGENTS.md`). It is short on purpose, since agents load it every session, and covers:

- the layout and what each layer may import,
- the conventions: `resource()` for CRUD, controllers and `action`/`get`/`post`…, constructor injection, `app/kernel.ts` hooks, domain errors,
- the commands: `qala generate`, `check --fix`, `routes --json`, `make:*`, `migrate:make`, `build`, `bun test`,
- the [native rules](./native) that break `qala build` but not Bun (named imports, no `export default`, non-async overrides, unions, default parameters in classes),
- "before you finish": `qala check --fix`, `bun test`, `qala build`.

Edit it freely: it is your project's file. For an existing app, copy the one from a fresh `qala new`.

## Docs for LLMs

The docs are published in LLM-friendly form:

- [`/llms.txt`](https://prestgg1.github.io/qala/llms.txt): an index of every page,
- [`/llms-full.txt`](https://prestgg1.github.io/qala/llms-full.txt): all docs in one file,
- every page as Markdown: add `.md` to its URL.

## JSON output

`qala check`, `qala routes` and `qala doctor` accept `--json` and then print exactly one JSON document on stdout (nothing else). Every document has `version` (currently `1`); fields may be added within a version, never removed or renamed.

### `qala check --json`

```json
{
  "version": 1,
  "ok": false,
  "files": 14,
  "diagnostics": [
    {
      "code": "QALA101",
      "severity": "error",
      "file": "app/domain/task.ts",
      "line": 3,
      "column": 1,
      "message": "domain must not import infrastructure (app/infrastructure/pg.ts): the domain is the core: …",
      "fix": "Depend on an abstract class in app/domain instead and let infrastructure extend it …",
      "docs": "https://prestgg1.github.io/qala/guide/project-layout"
    }
  ],
  "fixed": []
}
```

- `ok` is false when there is any `error` diagnostic. `warning`s (scriptc pitfalls `--fix` could not rewrite) do not fail the check.
- `line` and `column` are 1-based. `file` is relative to the app root.
- With `--fix`, `fixed` lists each rewrite: `{ code, file, line, column, message }`.
- Codes are listed in [qala check](./check#diagnostic-codes).

### `qala routes --json`

```json
{
  "version": 1,
  "routes": [
    { "method": "POST", "path": "/tasks/:id/complete", "controller": "tasks", "action": "complete", "file": "app/http/controllers/tasks.controller.ts", "line": 20 }
  ]
}
```

### `qala doctor --json`

```json
{
  "version": 1,
  "ok": true,
  "checks": [
    { "name": "Bun", "status": "ok", "detail": "1.3.2" },
    { "name": "clang", "status": "fail", "detail": "not found (scriptc needs it to link native binaries)", "hint": "apt install clang / xcode-select --install" }
  ]
}
```

`status` is `ok`, `warn` or `fail`; `hint` is present when there is something to do. `ok` is false when any check fails.

### Errors

If the command fails before it can produce its document (not inside an app, a controller that cannot be scanned, …), it prints

```json
{ "version": 1, "ok": false, "error": { "message": "app/http/controllers/bad.controller.ts:2: exports no controller: …" } }
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | success: no errors, all doctor checks pass or warn |
| `1` | failure: check errors, a failed doctor check, a failed build, or any other error |

`qala build` returns scriptc's exit code when the native compile fails.

## Errors an agent can act on

Messages name the file and the fix:

- `qala check` and `qala build` print `file:line  message [QALA1xx]` plus a fix hint and docs link per code.
- Controller scanning errors start with `file:line:` and show the expected shape.
- A failed native build ends with the usual causes (native subset, union mismatches like scriptc's SC2003, default parameters in object literals) and how to inspect them: `qala check --fix`, `bunx scriptc coverage .qala/main.ts`.
- At run time, `No provider registered for X` says whether to run `qala generate`, extend an abstract class in `app/infrastructure`, or bind it in `app/providers.ts`; missing environment variables point at `.env.example`.

## A loop that works

1. Make the change (prefer `qala make:*` for new files).
2. `qala generate` if you added controllers, models, services or env variables.
3. `qala check --fix --json`: fix every `error`, then look at the `warning`s.
4. `bun test`.
5. `qala build`: the native binary is the product; Bun passing is not enough.
