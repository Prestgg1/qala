import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CODES, type CheckJson, type DoctorJson, type RoutesJson } from "../src/diagnostics";
import { Container } from "../../core/src/container";
import { scriptcFailureHint } from "../src/run";
import { scaffold } from "../src/scaffold";

const REPO = resolve(import.meta.dir, "../../..");
const CORE = join(REPO, "packages/core/src/index.ts");
const BIN = join(REPO, "packages/cli/src/bin.ts");
const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});
setDefaultTimeout(60_000);

function app(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "qala-agent-"));
  temps.push(root);
  const all: Record<string, string> = {
    "package.json": '{ "name": "fixture", "private": true, "type": "module" }\n',
    "tsconfig.json": JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true, skipLibCheck: true, noEmit: true, types: ["node"], typeRoots: [join(REPO, "node_modules/@types")], paths: { "@qala/core": [CORE] } },
      include: ["app", "config"],
    }),
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function run(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
}

const CONTROLLER = `import { action, controller, post, t } from "@qala/core";

export const TasksController = controller({}, () => ({
  index: action({}, () => []),
  complete: post("/:id/complete", { params: { id: t.uuid() } }, ({ params }) => ({ id: params.id })),
}));
`;

describe("--json output", () => {
  test("check --json: stable codes, positions, fix hints and docs links; exit 1 on errors", () => {
    const root = app({
      "app/domain/x.ts": 'import { y } from "../infrastructure/y";\nexport const x = y;\n',
      "app/infrastructure/y.ts": "export const y = 1;\n",
      "app/application/z.ts": '  import { readFileSync } from "node:fs";\nexport const z = readFileSync;\n',
    });
    const r = run(root, "check", "--json");
    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout) as CheckJson;
    expect(doc.version).toBe(1);
    expect(doc.ok).toBe(false);
    expect(doc.files).toBe(3);
    expect(doc.fixed).toEqual([]);
    const byCode = Object.fromEntries(doc.diagnostics.map((d) => [d.code, d]));
    expect(byCode.QALA101).toMatchObject({ severity: "error", file: "app/domain/x.ts", line: 1, column: 1, fix: CODES.QALA101!.fix, docs: CODES.QALA101!.docs });
    expect(byCode.QALA101!.message).toContain("domain must not import infrastructure");
    expect(byCode.QALA102).toMatchObject({ file: "app/application/z.ts", line: 1, column: 3 });
    for (const d of doc.diagnostics) expect(Object.keys(d).sort()).toEqual(["code", "column", "docs", "file", "fix", "line", "message", "severity"]);
  });

  test("check --fix --json lists fixes with codes and unfixable notes as warnings", () => {
    const root = app({
      "app/shared/slug.ts": "export default function slug(s: string): string { return s.toLowerCase(); }\n",
      "app/shared/anon.ts": "export default (s: string) => s;\n",
    });
    const r = run(root, "check", "--fix", "--json");
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout) as CheckJson;
    expect(doc.ok).toBe(true);
    expect(doc.fixed).toEqual([{ code: "QALA205", file: "app/shared/slug.ts", line: 1, column: 1, message: "export default slug -> export slug" }]);
    expect(doc.diagnostics).toEqual([expect.objectContaining({ code: "QALA205", severity: "warning", file: "app/shared/anon.ts", line: 1 })]);
  });

  test("text check output carries the code and a fix hint", () => {
    const root = app({ "app/domain/x.ts": 'import "../infrastructure/y";\n', "app/infrastructure/y.ts": "export {};\n" });
    const r = run(root, "check");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("app/domain/x.ts:1  domain must not import infrastructure");
    expect(r.stderr).toContain("[QALA101]");
    expect(r.stderr).toContain("QALA101 fix:");
  });

  test("routes --json", () => {
    const root = app({ "app/http/controllers/tasks.controller.ts": CONTROLLER });
    const r = run(root, "routes", "--json");
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout) as RoutesJson;
    expect(doc).toEqual({
      version: 1,
      routes: [
        { method: "GET", path: "/tasks", controller: "tasks", action: "index", file: "app/http/controllers/tasks.controller.ts", line: 4 },
        { method: "POST", path: "/tasks/:id/complete", controller: "tasks", action: "complete", file: "app/http/controllers/tasks.controller.ts", line: 5 },
      ],
    });
  });

  test("doctor --json", () => {
    const root = app({});
    const r = run(root, "doctor", "--json");
    const doc = JSON.parse(r.stdout) as DoctorJson;
    expect(doc.version).toBe(1);
    expect(r.status).toBe(doc.ok ? 0 : 1);
    expect(doc.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["Bun", "Node.js", "Platform", "scriptc", "clang", "Project"]));
    for (const c of doc.checks) expect(["ok", "warn", "fail"]).toContain(c.status);
  });

  test("errors are JSON too with --json", () => {
    const root = app({ "app/http/controllers/bad.controller.ts": 'import { action } from "@qala/core";\nexport const Nope = action({}, () => 1);\n' });
    const r = run(root, "routes", "--json");
    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout) as { version: number; ok: boolean; error: { message: string } };
    expect(doc.ok).toBe(false);
    expect(doc.error.message).toContain("app/http/controllers/bad.controller.ts:1");
  });
});

describe("actionable errors", () => {
  test("a failed scriptc build explains what to do", () => {
    const hint = scriptcFailureHint(1);
    for (const needle of ["exit 1", "qala check --fix", "SC2003", "class methods", "bunx scriptc coverage .qala/main.ts", "/guide/native"]) expect(hint).toContain(needle);
  });

  test("a missing provider names the fix", () => {
    abstract class Mailer {}
    expect(() => new Container([]).get(Mailer)).toThrow(/No provider registered for Mailer\. Fix: run `qala generate`.*app\/infrastructure that extends Mailer.*app\/providers\.ts/);
  });

  test("an unknown action in resource() options is named", () => {
    const root = app({ "app/domain/task.ts": 'import { model, t } from "@qala/core";\nexport const Task = model("tasks", { id: t.uuid().primary() });\n', "app/http/controllers/tasks.controller.ts": 'import { resource } from "@qala/core";\nimport { Task } from "../../domain/task";\nexport const TasksController = resource(Task, { only: ["index", "list"] });\n' });
    const r = run(root, "routes");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('app/http/controllers/tasks.controller.ts:3: resource() option "only" lists unknown action "list"');
  });
});

describe("AGENTS.md", () => {
  test("qala new writes AGENTS.md and a CLAUDE.md that imports it", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "qala-agent-new-")), "shop");
    temps.push(dirname(dir));
    const files = scaffold(dir, { corePath: CORE });
    expect(files).toContain("AGENTS.md");
    expect(files).toContain("CLAUDE.md");
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(agents).toStartWith("# shop: notes for coding agents");
    for (const needle of ["llms.txt", "qala check --fix", "qala check --json", "qala build", "export default", "SC2003", "app/domain/", "app/kernel.ts", ".qala/", "make:controller"]) expect(agents).toContain(needle);
    // Agents read it every session: keep it short.
    expect(agents.split("\n").length).toBeLessThan(80);
  });

  test("every documented code is in docs/guide/check.md", () => {
    const doc = readFileSync(join(REPO, "docs/guide/check.md"), "utf8");
    for (const code of Object.keys(CODES)) expect(doc).toContain(code);
  });
});
