import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError, LAYOUT, camel, createFile, importPath, kebab, pascal, plural, singular, snake } from "./util";

export type MakeResult = { created: string[]; notes: string[] };

/** `tasks` / `Task` / `task-list` → the names a resource uses. */
export function resourceNames(input: string) {
  const one = singular(kebab(input).split("-").pop()!);
  const head = kebab(input).split("-").slice(0, -1);
  const singularKebab = [...head, one].join("-");
  const pluralKebab = [...head, plural(one)].join("-");
  return {
    Entity: pascal(singularKebab), // Task
    entity: camel(singularKebab), // task
    entities: camel(pluralKebab), // tasks
    file: singularKebab, // task
    pluralFile: pluralKebab, // tasks
    table: snake(pluralKebab), // tasks
  };
}

/**
 * Adds `singleton(Token, factory)` to app/providers.ts (and the imports it needs) when the file has the
 * standard `export const providers: Provider[] = [ ... ];` shape. Returns a note describing what happened.
 */
export function registerProvider(root: string, line: string, imports: { names: string; from: string }[]): string {
  const file = join(root, LAYOUT.providers);
  const manual = `register it in ${LAYOUT.providers}:  ${line}`;
  if (!existsSync(file)) return manual;
  let text = readFileSync(file, "utf8");
  // Only real code counts: the scaffolded doc comment shows the same line as an example.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  if (code.includes(line)) return `${LAYOUT.providers} already has it`;
  const start = text.indexOf("export const providers");
  const close = start === -1 ? -1 : text.indexOf("];", start);
  if (close === -1) return manual;
  text = `${text.slice(0, close)}  ${line}\n${text.slice(close)}`;
  const missing: string[] = [];
  const coreNames = ["singleton"];
  for (const imp of imports) {
    if (imp.from === "@qala/core") {
      coreNames.push(...imp.names.split(",").map((x) => x.trim()));
      continue;
    }
    const statement = `import { ${imp.names} } from "${imp.from}";`;
    if (!text.includes(statement)) missing.push(statement);
  }
  const core = /import (type )?\{([^}]*)\} from "@qala\/core";/.exec(text);
  const have = core === null ? [] : core[2]!.split(",").map((x) => (core[1] === undefined ? x.trim() : `type ${x.trim()}`)).filter((x) => x !== "" && x !== "type ");
  const add = coreNames.filter((x) => !have.includes(x) && !have.includes(`type ${x}`));
  if (add.length > 0) {
    if (core !== null) text = text.replace(core[0], `import { ${[...have, ...add].join(", ")} } from "@qala/core";`);
    else missing.unshift(`import { ${add.join(", ")} } from "@qala/core";`);
  }
  if (missing.length > 0) {
    const lines = text.split("\n");
    let last = -1;
    for (let i = 0; i < lines.length; i++) if (lines[i]!.startsWith("import ")) last = i;
    const at = last === -1 ? 0 : lines.slice(0, last + 1).join("\n").length + 1;
    text = `${text.slice(0, at)}${missing.join("\n")}\n${text.slice(at)}`;
  }
  writeFileSync(file, text);
  return `registered in ${LAYOUT.providers}`;
}

export function makeController(root: string, name: string, resource: boolean, force = false): MakeResult {
  const path = kebab(name.replace(/Controller$/, ""));
  if (path === "") throw new CliError("make:controller needs a name, e.g. qala make:controller tasks --resource");
  const segments = path.split("/");
  const last = segments.pop()!;
  const n = resourceNames(last);
  const file = `${LAYOUT.controllers}/${[...segments, last].join("/")}.controller.ts`;
  const exportName = `${pascal(last)}Controller`;
  const fileDir = join(root, LAYOUT.controllers, ...segments);
  const modelPath = join(root, LAYOUT.domain, `${n.file}.ts`);
  const hasModel = existsSync(modelPath);
  let content: string;
  if (!resource) {
    content = `import { controller, get } from "@qala/core";

export const ${exportName} = controller({}, () => ({
  hello: get("/hello", {}, () => ({ message: "Hello from ${last}" })),
}));
`;
  } else {
    // A resource: paginated, filterable CRUD validated by the model (docs/guide/resources.md).
    if (!hasModel) makeModel(root, last, force);
    content = `import { resource } from "@qala/core";
import { ${n.Entity} } from "${importPath(fileDir, modelPath)}";

/** /${path}: index (paginated) · show · store (201) · update · destroy (204), validated by ${n.Entity}. */
export const ${exportName} = resource(${n.Entity}, { defaultOrder: ["createdAt", "desc"] });
`;
  }
  createFile(root, file, content, force);
  const notes = [`routes are registered automatically under /${path} (run qala routes)`];
  if (resource && !hasModel) notes.push(`created the model ${LAYOUT.domain}/${n.file}.ts; create its table with: qala migrate:make create_${n.table}`);
  return { created: [file], notes };
}

export function makeModel(root: string, name: string, force = false): MakeResult {
  const n = resourceNames(name);
  const file = `${LAYOUT.domain}/${n.file}.ts`;
  createFile(
    root,
    file,
    `import { model, t, type InferCreate, type InferModel } from "@qala/core";

/** The "${n.table}" table: row type, validation, decoders and migrations all come from here. */
export const ${n.Entity} = model("${n.table}", {
  id: t.uuid().primary(),
  name: t.string({ min: 1, max: 200 }),
  createdAt: t.datetime().now(),
});
export type ${n.Entity} = InferModel<typeof ${n.Entity}>;

/** What a client may send to create a ${n.entity} (fields with defaults are optional). */
export const ${n.Entity}Input = ${n.Entity}.createSchema;
export type ${n.Entity}Input = InferCreate<typeof ${n.Entity}>;
`,
    force,
  );
  return { created: [file], notes: [`create the table with: qala migrate:make create_${n.table}`] };
}

export function makeRepository(root: string, name: string, force = false): MakeResult {
  const n = resourceNames(name);
  const contract = `${LAYOUT.domain}/${n.file}.repository.ts`;
  const impl = `${LAYOUT.infrastructure}/pg-${n.file}.repository.ts`;
  const created: string[] = [];
  const notes: string[] = [];
  if (!existsSync(join(root, LAYOUT.domain, `${n.file}.ts`))) {
    created.push(...makeModel(root, name, force).created);
  }
  created.push(
    createFile(
      root,
      contract,
      `import type { ${n.Entity}, ${n.Entity}Input } from "./${n.file}";

/** Storage of ${n.entities}. The application layer depends on this contract; infrastructure implements it. */
export abstract class ${n.Entity}Repository {
  abstract all(): Promise<${n.Entity}[]>;
  abstract find(id: string): Promise<${n.Entity} | null>;
  abstract create(input: ${n.Entity}Input): Promise<${n.Entity}>;
  abstract update(id: string, input: ${n.Entity}Input): Promise<${n.Entity} | null>;
  abstract delete(id: string): Promise<boolean>;
}
`,
      force,
    ),
  );
  created.push(
    createFile(
      root,
      impl,
      `import type { Database } from "@qala/core";
import { ${n.Entity}, type ${n.Entity}Input } from "../domain/${n.file}";
import { ${n.Entity}Repository } from "../domain/${n.file}.repository";

export class Pg${n.Entity}Repository extends ${n.Entity}Repository {
  constructor(private readonly db: Database) {
    super();
  }

  private get table() {
    return this.db.table(${n.Entity});
  }

  all(): Promise<${n.Entity}[]> {
    return this.table.all();
  }

  find(id: string): Promise<${n.Entity} | null> {
    return this.table.find(id);
  }

  create(input: ${n.Entity}Input): Promise<${n.Entity}> {
    return this.table.insert({ ...input });
  }

  update(id: string, input: ${n.Entity}Input): Promise<${n.Entity} | null> {
    return this.table.update(id, { ...input });
  }

  delete(id: string): Promise<boolean> {
    return this.table.delete(id);
  }
}
`,
      force,
    ),
  );
  notes.push(`wired automatically: qala generate binds ${n.Entity}Repository to Pg${n.Entity}Repository`);
  return { created, notes };
}

export function makeService(root: string, name: string, force = false): MakeResult {
  const n = resourceNames(name.replace(/Service$/, ""));
  const file = `${LAYOUT.application}/${n.file}.service.ts`;
  const hasRepo = existsSync(join(root, LAYOUT.domain, `${n.file}.repository.ts`));
  const service = `${n.Entity}Service`;
  const content = hasRepo
    ? `import type { ${n.Entity}, ${n.Entity}Input } from "../domain/${n.file}";
import { ${n.Entity}Repository } from "../domain/${n.file}.repository";

/** Use cases for ${n.entities}. \`null\` means "not found" (404); \`undefined\` "done, nothing to send" (204). */
export class ${service} {
  constructor(private readonly ${n.entities}: ${n.Entity}Repository) {}

  list(): Promise<${n.Entity}[]> {
    return this.${n.entities}.all();
  }

  get(id: string): Promise<${n.Entity} | null> {
    return this.${n.entities}.find(id);
  }

  create(input: ${n.Entity}Input): Promise<${n.Entity}> {
    return this.${n.entities}.create(input);
  }

  update(id: string, input: ${n.Entity}Input): Promise<${n.Entity} | null> {
    return this.${n.entities}.update(id, input);
  }

  async remove(id: string): Promise<null | undefined> {
    return (await this.${n.entities}.delete(id)) ? undefined : null;
  }
}
`
    : `/** Use cases for ${n.entities}. */
export class ${service} {
  hello(name: string): string {
    return \`Hello, \${name}\`;
  }
}
`;
  createFile(root, file, content, force);
  return { created: [file], notes: ["wired automatically: qala generate injects it wherever a constructor asks for it"] };
}

export function makeMiddleware(root: string, name: string, force = false): MakeResult {
  const file = `${LAYOUT.middleware}/${kebab(name)}.ts`;
  const fn = camel(name);
  createFile(
    root,
    file,
    `import type { Middleware } from "@qala/core";

/** Use globally in app/kernel.ts, or per controller: controller(deps, build, { middleware: [${fn}] }). */
export const ${fn}: Middleware = async (ctx, next) => {
  // before the handler: inspect ctx.header(...), ctx.bearer(), or ctx.set("key", value)
  const reply = await next();
  // after the handler
  return reply;
};
`,
    force,
  );
  return { created: [file], notes: [] };
}

export function makeTest(root: string, name: string, force = false): MakeResult {
  const n = resourceNames(name);
  const file = `test/${n.pluralFile}.test.ts`;
  const hasController = existsSync(join(root, LAYOUT.controllers, `${n.pluralFile}.controller.ts`));
  const calls = hasController
    ? `  test("${n.entities}.index", async () => {
    const ${n.entities} = await client.${n.entities}.index({});
    expect(Array.isArray(${n.entities})).toBe(true);
  });`
    : `  test("works", async () => {
    // await client.${n.entities}.index({});
    expect(client).toBeDefined();
  });`;
  createFile(
    root,
    file,
    `import { describe, expect, test } from "bun:test";
import { testApp } from "@qala/core/testing";
import { manifest, type Api } from "../.qala/api";
import { appOptions, setup } from "../.qala/app.gen";

// The app is wired exactly like the real entry point (controllers, providers, kernel, auth) and runs
// in-process: no socket, no binary. Pass headers: { authorization: "Bearer ..." } for auth routes, and
// wrap database writes in withRollback(db, ...) from "@qala/core/testing" to leave the database clean.
const { client } = testApp<Api>({ ...appOptions, manifest, setup });

describe("${n.entities}", () => {
${calls}
});
`,
    force,
  );
  return { created: [file], notes: ["run it with: bun test (needs qala generate once, which dev and build also run)"] };
}

/** `database/migrations/NNNN_<slug>.sql` with the next free number. */
function nextMigration(root: string, slug: string): string {
  const dir = join(root, LAYOUT.migrations);
  let next = 1;
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      const m = /^(\d+)_/.exec(f);
      if (m !== null) next = Math.max(next, Number(m[1]) + 1);
    }
  }
  return `${LAYOUT.migrations}/${String(next).padStart(4, "0")}_${slug}.sql`;
}

export function makeMigration(root: string, name: string): MakeResult {
  const slug = snake(name);
  if (slug === "") throw new CliError("make:migration needs a name, e.g. qala make:migration create_tasks");
  const file = nextMigration(root, slug);
  const table = /^create_(.+)$/.exec(slug)?.[1];
  const body =
    table !== undefined
      ? `create table ${table} (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);
`
      : "-- Write your migration here. Each file runs once, in order, inside a transaction.\n";
  createFile(root, file, body);
  return { created: [file], notes: ["apply with: qala migrate"] };
}

/**
 * The @qala/jobs table (same SQL as `jobsTableSql()` in packages/jobs/src/table.ts; a test keeps them equal).
 * Written as a migration by `qala make:jobs-table`.
 */
export function jobsTableSql(table: string = "qala_jobs"): string {
  return `create table ${table} (
  id bigserial primary key,
  queue text not null default 'default',
  name text not null,
  payload jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'dead')),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  run_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

-- What workers claim: pending jobs of a queue whose time has come.
create index ${table}_claim on ${table} (queue, run_at, id) where status = 'pending';
-- Stuck-job recovery scans running jobs by lock age.
create index ${table}_running on ${table} (locked_at) where status = 'running';
`;
}

/** `qala make:jobs-table`: the migration that creates the @qala/jobs table. */
export function makeJobsTable(root: string, table: string = "qala_jobs"): MakeResult {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new CliError(`make:jobs-table: "${table}" is not a plain lower-case table name`);
  const dir = join(root, LAYOUT.migrations);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (f.endsWith(`_create_${table}.sql`)) throw new CliError(`${LAYOUT.migrations}/${f} already creates ${table}`);
    }
  }
  const file = nextMigration(root, `create_${table}`);
  createFile(root, file, jobsTableSql(table));
  return { created: [file], notes: ["apply with: qala migrate", ...(table === "qala_jobs" ? [] : [`pass { table: "${table}" } to new Jobs(...)`])] };
}

/** `qala make:job send-welcome`: a job definition in app/application/jobs/. */
export function makeJob(root: string, name: string, force = false): MakeResult {
  const slug = kebab(name.replace(/Job$/, ""));
  if (slug === "") throw new CliError("make:job needs a name, e.g. qala make:job send-welcome");
  const file = `${LAYOUT.application}/jobs/${slug}.job.ts`;
  const constName = pascal(slug);
  createFile(
    root,
    file,
    `import { t } from "@qala/core";
import { defineJob } from "@qala/jobs";

/**
 * The "${slug}" job. Enqueue it from a service that injects \`Jobs\` (from @qala/jobs):
 *
 *   await this.jobs.enqueue(${constName}, { id }, { delay: 0, maxAttempts: 5 });   // add { tx } inside a transaction
 *
 * Payloads travel as JSON: keep the schema JSON-friendly (strings for dates).
 */
export const ${constName} = defineJob(
  "${slug}",
  t.object({ id: t.string() }),
  async (payload, job) => {
    // Services come from the app's container: job.container.get(SomeService).
    // Throwing retries the job with exponential backoff; after maxAttempts it is marked dead.
    console.log(\`${slug} \${payload.id} (attempt \${job.attempt}/\${job.maxAttempts})\`);
  },
  { maxAttempts: 5 },
);
`,
    force,
  );
  const notes = [
    `register it with the queue in ${LAYOUT.providers}: provide(Jobs, (c) => new Jobs(c.get(Database), [${constName}, ...]))`,
    `start a worker in ${LAYOUT.kernel}: export function onStart(app: App) { app.container.get(Jobs).start(app); }`,
  ];
  const dir = join(root, LAYOUT.migrations);
  const hasTable = existsSync(dir) && readdirSync(dir).some((f) => f.endsWith("_create_qala_jobs.sql"));
  if (!hasTable) notes.push("create the jobs table once with: qala make:jobs-table && qala migrate");
  return { created: [file], notes };
}
