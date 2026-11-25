import { existsSync, readdirSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { agentsMd, CLAUDE_MD } from "./agents";
import { CliError, createFile, kebab, rel } from "./util";

export type NewOptions = {
  /** Path to @qala/core's src/index.ts for tsconfig `paths` (default: the installed package). Useful inside the Qala repo. */
  corePath?: string;
  force?: boolean;
};

/** Scaffolds a new Qala app in `dir`. Returns the files written (relative to `dir`). */
export function scaffold(dir: string, options: NewOptions = {}): string[] {
  const root = resolve(dir);
  if (existsSync(root) && readdirSync(root).length > 0 && options.force !== true) throw new CliError(`${dir} is not empty (use --force to scaffold anyway)`);
  const name = kebab(basename(root)) || "qala-app";
  const core = options.corePath === undefined ? "./node_modules/@qala/core/src/index.ts" : toRelative(root, options.corePath);
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify(
      {
        name,
        private: true,
        type: "module",
        scripts: { dev: "qala dev", build: "qala build", start: "qala start", check: "qala check", routes: "qala routes", migrate: "qala migrate", test: "bun test", typecheck: "tsc --noEmit" },
        dependencies: { "@qala/core": "^0.1.0" },
        devDependencies: { "@qala/cli": "^0.1.0", "@types/bun": "^1.3.0", "@types/node": "^24.0.0", scriptc: "0.4.13", typescript: "^5.9.0" },
        trustedDependencies: ["scriptc"],
      },
      null,
      2,
    )}\n`,
    "tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: true,
          noEmit: true,
          types: ["node", "bun"],
          // scriptc compiles @qala/core as part of the app, so it is mapped to its TypeScript source.
          paths: { "@qala/core": [core], "@qala/core/query": [core.replace(/index\.ts$/, "orm/builder/index.ts")], "@qala/core/testing": [core.replace(/index\.ts$/, "testing.ts")] },
        },
        // ".qala" alone would not match: TypeScript skips dot-folders unless the glob names files in them.
        include: ["app", "config", "test", ".qala/**/*.ts"],
      },
      null,
      2,
    )}\n`,
    ".gitignore": "node_modules\n.qala\ndist\n.env\n",
    // The typed env (.qala/env.gen.ts) is generated from these lines; DATABASE_URL also provides `Database`.
    ".env.example": "PORT=3000 # type: number\nDATABASE_URL=postgres://postgres:postgres@localhost:5432/app # type: url\nLOG_LEVEL=info # type: enum(debug,info,warn,error)\nAPI_TOKEN=change-me\n",
    "app/kernel.ts": `import { cors, Logger, requestLogger, securityHeaders, type ErrorHandler, type Middleware } from "@qala/core";
import { env } from "../.qala/env.gen";

/** Global HTTP pipeline: middleware for every request and the app-wide error handler. */
export const kernel: { middleware?: Middleware[]; onError?: ErrorHandler; exposeErrors?: boolean } = {
  middleware: [requestLogger(new Logger(env.LOG_LEVEL)), cors(), securityHeaders()],
  exposeErrors: env.LOG_LEVEL === "debug",
};
`,
    "app/auth.ts": `import type { Context } from "@qala/core";
import { env } from "../.qala/env.gen";

export type AppUser = { name: string };

/** Who is calling: here a single API token; swap in sessions or JWTs. \`auth: true\` actions get \`user: AppUser\`. */
export async function authenticate(ctx: Context): Promise<AppUser | null> {
  return ctx.bearer() === env.API_TOKEN ? { name: "api" } : null;
}
`,
    "app/domain/note.ts": `import { model, t, type InferModel } from "@qala/core";

/** The "notes" table: row type, validation, decoders and migrations come from this one definition. */
export const Note = model("notes", {
  id: t.uuid().primary(),
  title: t.string({ min: 1, max: 200 }),
  done: t.boolean().default(false),
  createdAt: t.datetime().now(),
});
export type Note = InferModel<typeof Note>;
`,
    "app/http/controllers/notes.controller.ts": `import { resource } from "@qala/core";
import { Note } from "../../domain/note";

/** /notes: paginated, filterable CRUD validated by the model; writes need a user (app/auth.ts). */
export const NotesController = resource(Note, { filters: ["done"], defaultOrder: ["createdAt", "desc"], auth: true });
`,
    "app/http/controllers/health.controller.ts": `import { action, controller } from "@qala/core";

export const HealthController = controller({}, () => ({
  index: action({}, () => ({ status: "ok", time: new Date().toISOString() })),
}));
`,
    "database/migrations/0001_create_notes.sql": `create table notes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);
`,
    "app/domain/README.md": "Models, entities, domain rules and errors, and contracts (abstract classes) for what infrastructure provides. Imports nothing outside the domain.\n",
    "app/application/README.md": "Services / use cases. Constructor parameters are injected automatically (qala generate); no providers file needed.\n",
    "app/infrastructure/README.md": "Implementations of domain contracts: repositories on Database, mail, queues, HTTP clients.\n",
    "database/migrations/README.md": "SQL migrations, applied in order by `qala migrate`. `qala migrate:make <name>` writes one from the difference between your models and the database.\n",
    // Read by coding agents every session (AGENTS.md by most, CLAUDE.md by Claude Code, which imports it).
    "AGENTS.md": agentsMd(name),
    "CLAUDE.md": CLAUDE_MD,
    "README.md": `# ${name}

A [Qala](https://github.com/Prestgg1/qala) app.

\`\`\`sh
bun install
bun run dev          # qala dev: generate routes, run with Bun and reload on changes
bun run build        # qala build: architecture check + native binary in dist/app (scriptc)
bun run start        # run the native binary
\`\`\`

Add a CRUD resource in two commands: \`qala make:controller tasks --resource\` (model + controller), then \`qala migrate:make create_tasks && qala migrate\`.
Services and repositories are injected automatically from their constructor parameter types.
`,
  };
  const written: string[] = [];
  for (const path of Object.keys(files)) written.push(createFile(root, path, files[path]!, options.force === true));
  return written;
}

function toRelative(root: string, path: string): string {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  const r = rel(root, abs);
  return r.startsWith(".") ? r : `./${r}`;
}

