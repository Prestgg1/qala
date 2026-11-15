---
title: Writing code for scriptc
---

# Writing code for scriptc

Qala apps are compiled by [scriptc](https://scriptc.dev), which turns a statically analysable subset of TypeScript into machine code. Everything below was learned while building the framework against scriptc 0.4.13; `qala build` uses `--node-islands=off`, so code outside the subset fails the build instead of silently pulling in Node.js.

## Rules the framework follows (and your app code should too)

**Use named imports and exports.** `import http from "node:http"` and `export default` are not supported; write `import { createServer } from "node:http"`.

**Packages need declarations, so the framework ships as source.** scriptc compiles an npm package only if it ships its own `.d.ts`; Qala packages are TypeScript source, mapped with `tsconfig` `paths`, and compiled together with your code. `export * from "some-package"` is not supported either.

**Types are checked at run time at typed boundaries.** If a value claims a type it does not have, the native binary throws a `TypeError` where Bun would carry on. Keep types honest: a handler without a `params` schema receives `Record<string, string>`, not `{ id: string }`; declare `params: { id: t.uuid() }` to get a typed, validated `id`.

**Generic classes are specialised per type argument.** `Box<string>` and `Box<unknown>` are different native types and a value cannot move between them. The framework therefore keeps runtime values non-generic (`SchemaNode`, `ActionDef`, `ControllerDef`, `ModelDef`) and carries TypeScript types as phantom members:

```ts
export type Schema<T> = SchemaNode & { readonly __type?: () => T };
```

The phantom is wrapped in a function type because `unknown` and literal types do not compile as stored values, while function types always do.

**Generic functions are fine**, including inference from object literals (`action`, `get`, `model`, `db.table`). Prefer top-level generic functions over closures that return generic functions.

**Methods with default parameters must be class methods.** An object literal of functions (`const t = { string(rules = {}) {...} }`) is a record of function values, and function values with optional parameters are not supported yet; a class instance (`export const t = new SchemaBuilder()`) works.

**`keyof Row` is not a value type.** Compute key unions with TypeScript where the literal types are known (e.g. in `model()`) and carry them as a phantom (`Model<Row, Key>`).

**Narrow before casting into a union.** `row as Row` inside `Row | null` fails at run time; check for `null` first, then cast.

**Override abstract methods without `async`.** An `async` method cannot override an abstract method yet; return the promise instead (`find(id: string): Promise<Task | null> { return this.db.table(Task).find(id); }`). `qala check --fix` rewrites an `async` override for you.

**`void` is fine in handlers.** An action handler may return nothing (`void`/`Promise<void>`): it answers 204. Inside your own generic helpers, prefer `undefined` over `void` as a type argument; `transaction<T>` handles a callback returning nothing internally.

**Tagged templates cannot cross into a Node island.** Not a concern with `--node-islands=off`, but it is why Qala uses its own PostgreSQL client instead of `postgres` (which only runs as a Node island and is several times slower there).

## Checking your code

```sh
qala check --fix                      # rewrites the pitfalls above in app code (async overrides, abstract tokens,
                                      # union factories, untyped empty arrays, default imports/exports, export *)
bunx scriptc coverage .qala/main.ts   # what compiles statically, and why not
qala build                            # fails on anything that would need Node.js
```

Most of these rules never reach your code: dependency injection, providers, decoders and queries are generated with
the explicit types scriptc needs.
