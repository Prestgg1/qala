# `qala check`

Two jobs in one command.

## Architecture rules

`qala check` enforces the dependency rule (domain ← application ← infrastructure/http) over `app/` and `config/`, and prints every violation as `file:line  message`. It exits 1 on violations. `qala build` runs it first.

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
