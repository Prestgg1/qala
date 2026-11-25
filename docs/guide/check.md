# `qala check`

Two jobs in one command.

## Architecture rules

`qala check` enforces the dependency rule (domain ← application ← infrastructure/http) over `app/` and `config/`, and prints every violation as `file:line  message [CODE]` ([codes](#diagnostic-codes)). It exits 1 on violations. `qala check --json` prints the same as one JSON document. `qala build` runs it first.

## `qala check --fix`: scriptc pitfalls

scriptc compiles a statically analysable subset of TypeScript (see [scriptc.md](./native.md)). `--fix` finds the pitfalls below in your app code and rewrites them with minimal text edits (the TypeScript compiler API; formatting and comments stay), then runs the architecture check.

```
$ qala check --fix
fixed app/infrastructure/pg-task.repository.ts:12  PgTaskRepository.find: async override of an abstract method -> non-async, delegating to private async findAsync
fixed app/providers.ts:7  singleton(TaskRepository, ...): explicit type argument <TaskRepository> for an abstract token
fixed app/shared/slug.ts:1  export default slug -> export slug
3 fix(es) in 3 file(s)
✓ 15 files follow the dependency rule (domain ← application ← infrastructure/http).
```

| Pitfall | Fix |
|---|---|
| `async` method overriding an abstract method | non-async override returning a private async helper's promise |
| `singleton(X, …)` / `transient` / `value` with an abstract token and no type argument | adds `<X>` |
| factory returning a union where the abstract type is expected | annotates the return type `: X` |
| `{ items: [] }` where the slot is typed `T[]` | `[] as T[]` |
| `export default` / `import x from "./y"` | named export, named import (`import { y as x }` if the names differ) |
| `import path from "node:path"` | `import { join, sep } from "node:path"`, usages rewritten (skipped if a name would clash) |
| `export * from "pkg"` | the package's names listed (`export { … }` and `export type { … }`) |

Before and after:

```ts
// before
export class PgTaskRepository extends TaskRepository {
  async find(id: string): Promise<Task | null> { return this.db.table(Task).find(id); }
}
// after
export class PgTaskRepository extends TaskRepository {
  find(id: string): Promise<Task | null> { return this.findAsync(id); }

  private async findAsync(id: string): Promise<Task | null> { return this.db.table(Task).find(id); }
}
```

Things it cannot rewrite safely (anonymous default exports, generic or destructured parameters on an async override, a default import used as a value) are printed as `note: file:line  …` and left for you. Running it twice changes nothing the second time. Review the diff with `git diff`: the fixes are plain source edits.

## Diagnostic codes

Every diagnostic has a stable code. Text output ends each line with it (`… [QALA101]`) and prints one fix hint per code; `--json` gives the code, position, fix and docs link (see [JSON output](./ai#json-output)).

| Code | Severity | Meaning | Fix |
|---|---|---|---|
| QALA101 | error | a layer imports a layer it must not depend on | depend on an abstract class in `app/domain`; infrastructure extends it and injection wires it |
| QALA102 | error | a layer imports a package it must not use | wrap the package in `app/infrastructure` behind an abstract class from `app/domain` |
| QALA103 | error | a layer imports a composition root (`app/providers.ts`, `app/kernel.ts`, `app/auth.ts`, `app/events/`, `config/`) | take what you need as a constructor parameter |
| QALA104 | error | an import of a project file outside the layers | move the file under `app/domain`, `application`, `infrastructure`, `http` or `shared` |
| QALA105 | error | compiled queries used outside `app/infrastructure` | call them from a repository |
| QALA106 | error | a `.query.ts` declaration imported at run time | import from `.qala/queries.gen` |
| QALA201 | fixed / warning | `async` override of an abstract method | `--fix`, or return a private async helper's promise |
| QALA202 | fixed | abstract DI token without a type argument | `--fix`, or `singleton<X>(X, …)` |
| QALA203 | fixed | provider factory returning a union | `--fix`, or annotate the return type |
| QALA204 | fixed | untyped empty array literal | `--fix`, or `[] as T[]` |
| QALA205 | fixed / warning | default export | `--fix`; anonymous defaults need a name first |
| QALA206 | fixed / warning | default import | `--fix`, or named imports |
| QALA207 | fixed / warning | `export * from "pkg"` | `--fix`, or list the names |

QALA2xx codes are reported only with `--fix`: as `fixed` when rewritten, as warnings (`note:` in text) when they need a hand edit. Warnings do not change the exit code.

Exit codes: `0` no errors, `1` errors (or the command itself failed).
