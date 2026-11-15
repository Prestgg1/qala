import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { generate, renderMain } from "../src/codegen";
import { fieldExpression, renderModels, scanModels } from "../src/models";

const REPO = resolve(import.meta.dir, "../../..");
const CORE = join(REPO, "packages/core/src/index.ts");
const TSC = join(REPO, "node_modules/.bin/tsc");
const BIN = join(REPO, "packages/cli/src/bin.ts");
/** `useDecoder` and `pgIso` come from a parallel change to @qala/core; the generated file is typechecked once they exist. */
const coreSource = readFileSync(join(REPO, "packages/core/src/db/model.ts"), "utf8") + readFileSync(CORE, "utf8");
const coreHasDecoders = /useDecoder/.test(coreSource) && /pgIso/.test(coreSource);

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function app(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "qala-models-"));
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
        paths: { "@qala/core": [CORE] },
      },
      include: ["app", ".qala/**/*.ts"],
    }),
    "app/http/controllers/health.controller.ts": 'import { action, controller } from "@qala/core";\nexport const HealthController = controller({}, () => ({ index: action({}, () => ({ ok: true })) }));\n',
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const TASK = `import { model, t, type InferModel } from "@qala/core";

export const Task = model("tasks", {
  id: t.uuid(),
  title: t.string({ min: 1 }),
  description: t.nullable(t.string()),
  priority: t.integer({ min: 1, max: 4 }),
  done: t.boolean(),
  dueAt: t.nullable(t.datetime()),
  createdAt: t.datetime(),
});
export type Task = InferModel<typeof Task>;
`;

const EXPECTED_TASK =
  'Task.useDecoder((v: (string | null)[]): InferModel<typeof Task> => ({ id: v[0] ?? "", title: v[1] ?? "", description: v[2] ?? null, priority: Number(v[3]), done: v[4] === "t", dueAt: v[5] === null || v[5] === undefined ? null : pgIso(v[5]), createdAt: pgIso(v[6] ?? "") }));';

describe("model scan", () => {
  test("kinds and nullability", () => {
    const root = app({
      "app/domain/kinds.ts": `import { model, t as s } from "@qala/core";
export const Kinds = model("kinds", {
  a: s.uuid(), b: s.string(), c: s.email(), d: s.enum(["x", "y"]), e: s.unknown(),
  f: s.integer(), g: s.number({ min: 0 }), h: s.boolean(), i: s.datetime(),
  j: s.optional(s.integer()), k: s.optional(s.nullable(s.boolean())), l: s.nullable(s.optional(s.datetime())), m: (s.nullable(s.email())),
  "with-dash": s.string(),
});
`,
    });
    const { models, skipped } = scanModels(root);
    expect(skipped).toEqual([]);
    expect(models).toHaveLength(1);
    expect(models[0]!.table).toBe("kinds");
    expect(models[0]!.fields.map((f) => `${f.name}:${f.kind}${f.nullable ? "?" : ""}`)).toEqual([
      "a:text", "b:text", "c:text", "d:text", "e:text",
      "f:number", "g:number", "h:boolean", "i:datetime",
      "j:number?", "k:boolean?", "l:datetime?", "m:text?",
      "with-dash:text",
    ]);
    const out = renderModels(root, models);
    expect(out).toContain('"with-dash": v[13] ?? ""');
    expect(out).toContain('d: (v[3] ?? "") as InferModel<typeof Kinds>["d"]');
  });

  test("decoder expressions follow the column rules", () => {
    expect(fieldExpression({ name: "x", kind: "text", nullable: false, literal: false }, 0)).toBe('v[0] ?? ""');
    expect(fieldExpression({ name: "x", kind: "text", nullable: true, literal: false }, 1)).toBe("v[1] ?? null");
    expect(fieldExpression({ name: "x", kind: "number", nullable: false, literal: false }, 2)).toBe("Number(v[2])");
    expect(fieldExpression({ name: "x", kind: "number", nullable: true, literal: false }, 3)).toBe("v[3] === null || v[3] === undefined ? null : Number(v[3])");
    expect(fieldExpression({ name: "x", kind: "boolean", nullable: false, literal: false }, 4)).toBe('v[4] === "t"');
    expect(fieldExpression({ name: "x", kind: "boolean", nullable: true, literal: false }, 5)).toBe('v[5] === null || v[5] === undefined ? null : v[5] === "t"');
    expect(fieldExpression({ name: "x", kind: "datetime", nullable: false, literal: false }, 6)).toBe('pgIso(v[6] ?? "")');
    expect(fieldExpression({ name: "x", kind: "datetime", nullable: true, literal: false }, 7)).toBe("v[7] === null || v[7] === undefined ? null : pgIso(v[7])");
  });

  test("models it cannot describe are skipped with a reason", () => {
    const root = app({
      "app/domain/odd.ts": `import { model, t } from "@qala/core";
const base = { id: t.uuid() };
const title = t.string();
const key = "k";
export const Spread = model("a", { ...base, name: t.string() });
export const Nested = model("b", { id: t.uuid(), tags: t.array(t.string()) });
export const Obj = model("c", { id: t.uuid(), meta: t.nullable(t.object({ x: t.string() })) });
export const Variable = model("d", { id: t.uuid(), title });
export const Computed = model("e", { [key]: t.string() });
export const NotLiteral = model(\`\${key}s\`, { id: t.uuid() });
export const Fine = model("f", { id: t.uuid() });
`,
      "app/domain/elsewhere.ts": `// a different "model" helper is not ours
function model(table: string, shape: object) { return { table, shape }; }
export const Unrelated = model("x", {});
`,
    });
    const { models, skipped } = scanModels(root);
    expect(models.map((m) => m.exportName)).toEqual(["Fine"]);
    expect(skipped.map((s) => `${s.exportName}: ${s.reason}`)).toEqual([
      "Spread: the shape uses a spread, shorthand or method; write every field as `name: t.kind()`",
      'Nested: field "tags": t.array() has no column decoder (only scalar kinds are generated)',
      'Obj: field "meta": t.object() has no column decoder (only scalar kinds are generated)',
      'Variable: the shape uses a spread, shorthand or method; write every field as `name: t.kind()`',
      "Computed: the shape has a computed key",
      "NotLiteral: the table name is not a string literal",
    ]);
    expect(skipped[0]!.relFile).toBe("app/domain/odd.ts");
    expect(skipped[0]!.line).toBe(5);
  });
});

describe("models.gen.ts", () => {
  test("exact output", () => {
    const root = app({ "app/domain/task.ts": TASK });
    generate(root);
    expect(readFileSync(join(root, ".qala/models.gen.ts"), "utf8")).toBe(
      [
        "// generated by qala — do not edit",
        "",
        'import { pgIso, type InferModel } from "@qala/core";',
        'import { Task } from "../app/domain/task";',
        "",
        EXPECTED_TASK,
        "",
      ].join("\n"),
    );
  });

  test("models sharing a name get path-qualified aliases", () => {
    const root = app({
      "app/domain/task.ts": TASK,
      "app/infrastructure/archive/task.ts": 'import { model, t } from "@qala/core";\nexport const Task = model("archived_tasks", { id: t.uuid(), at: t.datetime() });\n',
      "app/domain/comment.ts": 'import { model, t } from "@qala/core";\nexport const Comment = model("comments", { id: t.uuid() });\n',
    });
    generate(root);
    const out = readFileSync(join(root, ".qala/models.gen.ts"), "utf8");
    expect(out).toContain('import { Comment } from "../app/domain/comment";');
    expect(out).toContain('import { Task as DomainTaskTask } from "../app/domain/task";');
    expect(out).toContain('import { Task as InfrastructureArchiveTaskTask } from "../app/infrastructure/archive/task";');
    expect(out).toContain("DomainTaskTask.useDecoder((v: (string | null)[]): InferModel<typeof DomainTaskTask> => ({ id: v[0] ?? \"\"");
    expect(out).toContain('InfrastructureArchiveTaskTask.useDecoder((v: (string | null)[]): InferModel<typeof InfrastructureArchiveTaskTask> => ({ id: v[0] ?? "", at: pgIso(v[1] ?? "") }));');
  });

  test("main.ts imports the decoders before creating the app", () => {
    const root = app({ "app/domain/task.ts": TASK });
    generate(root);
    const main = readFileSync(join(root, ".qala/main.ts"), "utf8");
    const at = main.indexOf('import "./models.gen";');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(main.indexOf("import { controllers }"));
    expect(at).toBeLessThan(main.indexOf("createApp({"));
    expect(renderMain(root, false)).not.toContain("models.gen");
  });

  test("no models: no file, no import, and a stale file is removed", () => {
    const root = app({ "app/domain/task.ts": TASK });
    generate(root);
    expect(existsSync(join(root, ".qala/models.gen.ts"))).toBe(true);
    rmSync(join(root, "app/domain/task.ts"));
    const { models } = generate(root);
    expect(models).toEqual([]);
    expect(existsSync(join(root, ".qala/models.gen.ts"))).toBe(false);
    expect(readFileSync(join(root, ".qala/main.ts"), "utf8")).not.toContain("models.gen");
  });

  test("writes are idempotent", () => {
    const root = app({ "app/domain/task.ts": TASK });
    const first = generate(root);
    expect(first.written).toContain(".qala/models.gen.ts");
    const file = join(root, ".qala/models.gen.ts");
    const mtime = statSync(file).mtimeMs;
    const second = generate(root);
    expect(second.written).toEqual([]);
    expect(statSync(file).mtimeMs).toBe(mtime);
  });

  test("qala generate reports the decoders and skipped models", () => {
    const root = app({
      "app/domain/task.ts": TASK,
      "app/domain/odd.ts": 'import { model, t } from "@qala/core";\nexport const Odd = model("odd", { tags: t.array(t.string()) });\n',
    });
    const r = spawnSync(process.execPath, [BIN, "generate"], { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("✓ 1 model decoder");
    expect(r.stdout).toContain("note: app/domain/odd.ts:2 model Odd uses the generic decoder");
  });

  test.if(coreHasDecoders)("the generated file typechecks against @qala/core", () => {
    const root = app({
      "app/domain/task.ts": TASK,
      "app/domain/kinds.ts": 'import { model, t } from "@qala/core";\nexport const Kinds = model("kinds", { n: t.optional(t.integer()), b: t.nullable(t.boolean()), e: t.enum(["a", "b"]) });\n',
    });
    generate(root);
    const r = spawnSync(TSC, ["-p", join(root, "tsconfig.json")], { encoding: "utf8" });
    expect((r.stdout + r.stderr).trim()).toBe("");
  });
});
