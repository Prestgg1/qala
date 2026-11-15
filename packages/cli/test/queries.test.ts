import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkArchitecture } from "../src/check";
import { generate } from "../src/codegen";
import { generateQueries } from "../src/queries";

const REPO = resolve(import.meta.dir, "../../..");
const CORE = join(REPO, "packages/core/src/index.ts");
const QUERY = join(REPO, "packages/core/src/orm/builder/index.ts");
const TSC = join(REPO, "node_modules/.bin/tsc");

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function app(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "qala-queries-"));
  temps.push(root);
  const all: Record<string, string> = {
    "package.json": '{ "name": "fixture", "private": true, "type": "module" }\n',
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: true,
        noEmit: true,
        types: ["node", "bun"],
        typeRoots: [join(REPO, "node_modules/@types")],
        paths: { "@qala/core": [CORE], "@qala/core/query": [QUERY] },
      },
      include: ["app", ".qala/**/*.ts"],
    }),
    "app/http/controllers/health.controller.ts": 'import { action, controller } from "@qala/core";\nexport const HealthController = controller({}, () => ({ index: action({}, () => ({ ok: true })) }));\n',
    "app/domain/task.ts": `import { model, t } from "@qala/core";
export const Task = model("tasks", { id: t.uuid(), title: t.string(), done: t.boolean(), projectId: t.uuid() });
export const Note = model("notes", { id: t.uuid(), taskId: t.uuid(), body: t.string() });
`,
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const QUERIES = `import { defineQuery, eq, from, many, param } from "@qala/core/query";
import { Note, Task } from "../../domain/task";

export const openTasks = defineQuery({
  params: { projectId: param.uuid(), done: param.optional(param.boolean()) },
  query: (p) =>
    from({ t: Task })
      .where((r) => eq(r.t.projectId, p.projectId))
      .where((r) => eq(r.t.done, p.done))
      .select((r) => ({ id: r.t.id, title: r.t.title, notes: many({ n: Note }, { key: (n) => n.n.taskId, parent: r.t.id }) })),
});
`;

describe("qala generate: queries", () => {
  test("compiles query declarations into .qala/queries.gen.ts, which typechecks", () => {
    const root = app({ "app/infrastructure/queries/tasks.query.ts": QUERIES });
    const { queries, written } = generate(root);
    expect(queries).toBe(1);
    expect(written).toContain(".qala/queries.gen.ts");
    const gen = readFileSync(join(root, ".qala/queries.gen.ts"), "utf8");
    expect(gen).toContain('import type { openTasks as D_openTasks } from "../app/infrastructure/queries/tasks.query";');
    // Column-bound parameters are bare (Postgres types them from the column); the null test comes second.
    expect(gen).toContain('(\\"t\\".\\"done\\" = $2 or $2 is null)');
    expect(gen).toContain("export const Queries = { openTasks };");
    expect(existsSync(join(root, ".qala/compile-queries.ts"))).toBe(false);
    const tsc = spawnSync(TSC, ["-p", "tsconfig.json"], { cwd: root, encoding: "utf8" });
    expect(tsc.stdout + tsc.stderr).toBe("");
    // Unchanged declarations: nothing is rewritten.
    expect(generateQueries(root).written).toBe(false);
  });

  test("a stale generated file fails tsc once the declaration changes", () => {
    const root = app({ "app/infrastructure/queries/tasks.query.ts": QUERIES });
    generate(root);
    writeFileSync(join(root, "app/infrastructure/queries/tasks.query.ts"), QUERIES.replace("title: r.t.title, ", ""));
    const tsc = spawnSync(TSC, ["-p", "tsconfig.json"], { cwd: root, encoding: "utf8" });
    expect(tsc.stdout).toContain("title");
  });

  test("compile errors name the file and query; duplicate names are rejected", () => {
    const bad = app({ "app/infrastructure/queries/a.query.ts": QUERIES, "app/infrastructure/queries/b.query.ts": QUERIES });
    expect(() => generate(bad)).toThrow(/query "openTasks" is declared in .*a\.query\.ts and .*b\.query\.ts/);
    const limited = app({
      "app/infrastructure/queries/x.query.ts": QUERIES.replace("{ key: (n) => n.n.taskId, parent: r.t.id }", "{ key: (n) => n.n.taskId, parent: r.t.id, query: (q) => q.limit(1).select((n) => n.n) }"),
    });
    expect(() => generate(limited)).toThrow(/x\.query\.ts: query "openTasks": Relations cannot have limit/);
  });

  test("no declarations: no file (and a stale one is removed)", () => {
    const root = app({ "app/infrastructure/queries/tasks.query.ts": QUERIES });
    generate(root);
    rmSync(join(root, "app/infrastructure/queries/tasks.query.ts"));
    expect(generate(root).queries).toBe(0);
    expect(existsSync(join(root, ".qala/queries.gen.ts"))).toBe(false);
  });
});

describe("qala check: queries", () => {
  test("only infrastructure runs compiled queries; declarations are never imported at run time", () => {
    const root = app({
      "app/infrastructure/queries/tasks.query.ts": QUERIES,
      "app/infrastructure/task.repository.ts": 'import { Queries } from "../../.qala/queries.gen";\nimport type { openTasks } from "./queries/tasks.query";\nexport const q = Queries;\nexport type T = typeof openTasks;\n',
      "app/infrastructure/bad.repository.ts": 'import { openTasks } from "./queries/tasks.query";\nexport const q = openTasks;\n',
      "app/application/task.service.ts": 'import { Queries } from "../../.qala/queries.gen";\nexport const q = Queries;\n',
    });
    generate(root);
    const messages = checkArchitecture(root).violations.map((v) => `${v.file}: ${v.message}`);
    expect(messages).toEqual([
      "app/application/task.service.ts: application imports compiled queries; only app/infrastructure runs SQL (wrap it in a repository)",
      "app/infrastructure/bad.repository.ts: query declarations are build-time only; import the compiled query from .qala/queries.gen instead",
    ]);
  });
});
