import { existsSync, readdirSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
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
        scripts: { dev: "qala dev", build: "qala build", start: "qala start", check: "qala check", routes: "qala routes", migrate: "qala migrate", typecheck: "tsc --noEmit" },
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
          paths: { "@qala/core": [core], "@qala/core/query": [core.replace(/index\.ts$/, "orm/builder/index.ts")] },
        },
        // ".qala" alone would not match: TypeScript skips dot-folders unless the glob names files in them.
        include: ["app", "config", ".qala/**/*.ts"],
      },
      null,
      2,
    )}\n`,
    ".gitignore": "node_modules\n.qala\ndist\n.env\n",
    ".env.example": "PORT=3000\nDATABASE_URL=postgres://postgres:postgres@localhost:5432/app\nLOG_LEVEL=info\n",
    "config/app.ts": `import { defineConfig } from "@qala/core";

/** Every setting the app reads, typed and validated at startup (from the environment and .env). */
export const config = defineConfig((env) => ({
  port: env.number("PORT", 3000),
  databaseUrl: env.string("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/app"),
  logLevel: env.oneOf("LOG_LEVEL", ["debug", "info", "warn", "error"] as const, "info"),
}));
`,
    "app/providers.ts": `import type { Provider } from "@qala/core";

/**
 * The composition root: which implementation serves each dependency.
 * \`qala make:service\` and \`qala make:repository\` add their lines here, e.g.
 *   singleton(Database, () => new Database(config.databaseUrl)),
 *   singleton(TaskRepository, (c) => new PgTaskRepository(c.get(Database))),
 */
export const providers: Provider[] = [
];
`,
    "app/kernel.ts": `import { cors, Logger, requestLogger, securityHeaders, type ErrorHandler, type Middleware } from "@qala/core";
import { config } from "../config/app";

const logger = new Logger(config.logLevel);

/** Global HTTP pipeline: middleware for every request and the app-wide error handler. */
export const kernel: { middleware?: Middleware[]; onError?: ErrorHandler; exposeErrors?: boolean } = {
  middleware: [requestLogger(logger), cors(), securityHeaders()],
  exposeErrors: config.logLevel === "debug",
};
`,
    "app/http/controllers/health.controller.ts": `import { action, controller } from "@qala/core";

export const HealthController = controller({}, () => ({
  index: action({}, () => ({ status: "ok", time: new Date().toISOString() })),
}));
`,
    "app/domain/README.md": "Entities, value objects, domain errors and repository contracts (abstract classes). Imports nothing outside the domain.\n",
    "app/application/README.md": "Services / use cases. Depend on the domain only; get infrastructure through domain contracts.\n",
    "app/infrastructure/README.md": "Implementations of domain contracts: repositories on Database, mail, queues, HTTP clients.\n",
    "database/migrations/README.md": "SQL migrations, applied in order by `qala migrate` (create one with `qala make:migration <name>`).\n",
    "README.md": `# ${name}

A [Qala](https://github.com/Prestgg1/qala) app.

\`\`\`sh
bun install
bun run dev          # qala dev: generate routes, run with Bun and reload on changes
bun run build        # qala build: architecture check + native binary in dist/app (scriptc)
bun run start        # run the native binary
\`\`\`

Add code with \`qala make:model task\`, \`qala make:repository task\`, \`qala make:service task\`, \`qala make:controller tasks --resource\`.
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

