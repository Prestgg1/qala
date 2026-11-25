import { DOCS } from "./diagnostics";

/** AGENTS.md for a new app: the rules a coding agent needs every session. Kept short on purpose. */
export function agentsMd(name: string): string {
  return `# ${name}: notes for coding agents

A [Qala](https://github.com/Prestgg1/qala) backend. TypeScript, compiled to one native binary by scriptc. Bun runs it in development and tests; production is the binary, so **code must compile natively**, not just run on Bun.

Full docs for LLMs: ${DOCS}/llms.txt (index) and ${DOCS}/llms-full.txt (everything in one file).

## Layout (enforced by \`qala check\`)

- \`app/domain/\` models (\`model("table", {...})\`), entities, domain errors, abstract classes for what infrastructure provides. Imports only domain and \`@qala/core\`.
- \`app/application/\` services. Imports domain and application only.
- \`app/infrastructure/\` implementations (\`class PgXRepository extends XRepository\`), any package.
- \`app/http/controllers/<name>.controller.ts\` one controller per file, export ends in \`Controller\`; the path gives the prefix (\`admin/users.controller.ts\` → \`/admin/users\`). Never import infrastructure here.
- \`app/kernel.ts\` global middleware, \`onError\`, optional \`onStart(app, { primary })\` / \`onShutdown(app)\` hooks. \`app/auth.ts\` \`authenticate(ctx)\`. \`app/providers.ts\` (optional) manual bindings.
- \`database/migrations/NNNN_name.sql\`, \`test/\`, \`.env\` (\`.env.example\` declares variables and types).
- \`.qala/\` is generated: never edit it, regenerate with \`qala generate\`.

## Conventions

- CRUD: \`export const XController = resource(Model, { filters: [...], auth: true })\`.
- Custom controllers: \`export class TasksController { constructor(private tasks: TaskService) {} index = action({}, () => this.tasks.list()); complete = post("/:id/complete", { params: { id: t.uuid() } }, ({ id }) => this.tasks.complete(id)); }\`. \`action()\` is only for index/show/store/update/destroy; other routes use \`get/post/put/patch/del("/path", ...)\`.
- Validate input with schemas (\`params\`, \`query\`, \`body\`); untyped params are \`Record<string, string>\`.
- DI is generated from constructor parameter types: no decorators, no container calls. An abstract class with one subclass is bound automatically.
- Throw \`NotFoundError\`, \`ConflictError\`, \`DomainError\` (422) etc.; the kernel maps them to status codes.

## Commands

\`\`\`sh
qala generate                 # after adding/renaming controllers, models, services, env vars
qala check --fix              # rewrites native pitfalls, then checks layers (exit 1 on violations)
qala check --json             # same, machine-readable: code, file, line, column, fix, docs
qala routes --json            # every route with its file and line
qala make:controller x --resource | make:model | make:repository | make:service | make:middleware | make:test | make:migration
qala migrate:make <name> && qala migrate
qala build                    # check + generate + native binary in dist/app
bun test                      # tests (qala make:test x writes one)
qala doctor --json            # toolchain and database
\`\`\`

## Native rules (break \`qala build\`, not Bun)

- Named imports and exports only: no \`export default\`, no \`import x from\`, no \`export * from "pkg"\`.
- Override abstract methods without \`async\`: return the promise.
- Narrow before casting into a union (\`if (row === null) ...\`, then \`row as Row\`); union mismatches show up as scriptc SC2003.
- Functions with default parameters belong in classes, not object literals of functions.
- Type empty arrays (\`[] as Task[]\`); give abstract DI tokens a type argument (\`singleton<X>(X, ...)\`).
- No dynamic \`import()\`, no packages without \`.d.ts\`, no \`any\`-shaped data: types are checked at run time natively.
- Details: ${DOCS}/guide/native

## Before you finish

1. \`qala check --fix\` (then \`qala check\` passes)
2. \`bun test\`
3. \`qala build\`: the native build must succeed. If scriptc fails, read the file:line it prints and the rules above.
`;
}

/** CLAUDE.md: Claude Code reads it; it imports AGENTS.md so the rules live in one place. */
export const CLAUDE_MD = "@AGENTS.md\n";
