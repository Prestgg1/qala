import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { generate } from "../src/codegen";

const REPO = resolve(import.meta.dir, "../../..");
const CORE = join(REPO, "packages/core/src/index.ts");
const TSC = join(REPO, "node_modules/.bin/tsc");

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function app(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "qala-di-"));
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
      include: ["app", ".qala/routes.gen.ts", ".qala/providers.gen.ts", ".qala/api.ts"],
    }),
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const read = (root: string, path: string): string => readFileSync(join(root, path), "utf8");

/** A layered app with no hand-written wiring except the Database built from config. */
const LAYERED: Record<string, string> = {
  "app/domain/task.repository.ts": "export abstract class TaskRepository {\n  abstract all(): Promise<string[]>;\n}\n",
  "app/infrastructure/pg-task.repository.ts":
    'import { Database } from "@qala/core";\nimport { TaskRepository } from "../domain/task.repository";\n' +
    "export class PgTaskRepository extends TaskRepository {\n  constructor(private readonly db: Database) {\n    super();\n  }\n  all(): Promise<string[]> {\n    return Promise.resolve([]);\n  }\n}\n",
  "app/application/clock.ts": "export class Clock {\n  now(): number {\n    return Date.now();\n  }\n}\n",
  "app/application/task.service.ts":
    'import { TaskRepository } from "../domain/task.repository";\nimport { Clock } from "./clock";\n' +
    "export class TaskService {\n  constructor(\n    private readonly tasks: TaskRepository,\n    private readonly clock: Clock,\n    private readonly label: string = \"tasks\",\n  ) {}\n  list(): Promise<string[]> {\n    return this.tasks.all();\n  }\n}\n",
  "app/http/controllers/tasks.controller.ts":
    'import { action, get } from "@qala/core";\nimport { TaskService } from "../../application/task.service";\n' +
    "export class TasksController {\n  constructor(private readonly tasks: TaskService) {}\n  index = action({}, () => this.tasks.list());\n  latest = get(\"/latest\", {}, () => this.tasks.list());\n}\n",
  "app/providers.ts": 'import { Database, provide, type Provider } from "@qala/core";\nexport const providers: Provider[] = [provide(Database, () => new Database("postgres://u:p@localhost:5432/db"))];\n',
};

describe("automatic dependency injection", () => {
  test("generates providers from constructor types and binds the single implementation", () => {
    const root = app(LAYERED);
    const result = generate(root);
    expect(result.providers).toBe(5);
    const gen = read(root, ".qala/providers.gen.ts");
    expect(gen).toContain("bind<TaskRepository>(TaskRepository, PgTaskRepository),");
    expect(gen).toContain("singleton<PgTaskRepository>(PgTaskRepository, (c) => new PgTaskRepository(c.get<Database>(Database))),");
    // the defaulted string parameter is left to its default
    expect(gen).toContain("singleton<TaskService>(TaskService, (c) => new TaskService(c.get<TaskRepository>(TaskRepository), c.get<Clock>(Clock))),");
    expect(gen).toContain("singleton<Clock>(Clock, () => new Clock()),");
    expect(gen).toContain("singleton<TasksController>(TasksController, (c) => new TasksController(c.get<TaskService>(TaskService))),");
    expect(read(root, ".qala/routes.gen.ts")).toContain("classController<TasksController>(TasksController, (x) => ({ index: x.index, latest: x.latest }))");
    expect(read(root, ".qala/api.ts")).toContain("tasks: ClassController<TasksController>;");
    expect(read(root, ".qala/main.ts")).toContain("providers: [...generatedProviders, ...providers],");
    const tsc = spawnSync(TSC, ["-p", join(root, "tsconfig.json")], { encoding: "utf8" });
    expect((tsc.stdout + tsc.stderr).trim()).toBe("");
  });

  test("works without app/providers.ts when nothing external is needed", () => {
    const files = { ...LAYERED };
    delete files["app/providers.ts"];
    files["app/infrastructure/pg-task.repository.ts"] =
      'import { TaskRepository } from "../domain/task.repository";\nexport class MemoryTaskRepository extends TaskRepository {\n  all(): Promise<string[]> {\n    return Promise.resolve(["a"]);\n  }\n}\n';
    const root = app(files);
    generate(root);
    expect(read(root, ".qala/providers.gen.ts")).toContain("bind<TaskRepository>(TaskRepository, MemoryTaskRepository),");
    expect(read(root, ".qala/main.ts")).toContain("providers: generatedProviders,");
  });

  test("two implementations without a choice is an error that names the fix", () => {
    const root = app({
      ...LAYERED,
      "app/infrastructure/memory-task.repository.ts":
        'import { TaskRepository } from "../domain/task.repository";\nexport class MemoryTaskRepository extends TaskRepository {\n  all(): Promise<string[]> {\n    return Promise.resolve([]);\n  }\n}\n',
    });
    expect(() => generate(root)).toThrow(/abstract TaskRepository has 2 implementations \(MemoryTaskRepository, PgTaskRepository\); choose one in app\/providers\.ts: bind\(TaskRepository, MemoryTaskRepository\)/);
  });

  test("bind() in app/providers.ts resolves the ambiguity", () => {
    const root = app({
      ...LAYERED,
      "app/infrastructure/memory-task.repository.ts":
        'import { TaskRepository } from "../domain/task.repository";\nexport class MemoryTaskRepository extends TaskRepository {\n  all(): Promise<string[]> {\n    return Promise.resolve([]);\n  }\n}\n',
      "app/providers.ts":
        'import { bind, Database, provide, type Provider } from "@qala/core";\nimport { TaskRepository } from "./domain/task.repository";\nimport { MemoryTaskRepository } from "./infrastructure/memory-task.repository";\n' +
        'export const providers: Provider[] = [provide(Database, () => new Database("postgres://u:p@localhost:5432/db")), bind(TaskRepository, MemoryTaskRepository)];\n',
    });
    generate(root);
    const gen = read(root, ".qala/providers.gen.ts");
    expect(gen).not.toContain("bind<TaskRepository>");
    expect(gen).toContain("singleton<MemoryTaskRepository>(MemoryTaskRepository, () => new MemoryTaskRepository()),");
  });

  test("an external token nobody provides is an error with a hint", () => {
    const files = { ...LAYERED };
    delete files["app/providers.ts"];
    const root = app(files);
    expect(() => generate(root)).toThrow(/Database \(from @qala\/core\) is not a class in app\/; register it in app\/providers\.ts, e\.g\. provide\(Database/);
  });

  test("a primitive constructor parameter without a default is an error with a hint", () => {
    const root = app({
      ...LAYERED,
      "app/application/clock.ts": "export class Clock {\n  constructor(private readonly zone: string) {}\n}\n",
    });
    expect(() => generate(root)).toThrow(/Clock's constructor parameter "zone: string" \(app\/application\/clock\.ts:2\) is not a class; give it a default value, or build Clock yourself: provide\(Clock/);
  });

  test("a dependency cycle is reported with its path", () => {
    const root = app({
      ...LAYERED,
      "app/application/clock.ts": 'import { TaskService } from "./task.service";\nexport class Clock {\n  constructor(private readonly tasks: TaskService) {}\n}\n',
    });
    expect(() => generate(root)).toThrow(/circular dependency: TaskService → Clock → TaskService/);
  });

  test("a dynamic app/providers.ts (spreads) turns unknowns into notes instead of errors", () => {
    const files = { ...LAYERED };
    files["app/providers.ts"] = 'import type { Provider } from "@qala/core";\nimport { core } from "./providers/core";\nexport const providers: Provider[] = [...core];\n';
    files["app/providers/core.ts"] = 'import { Database, provide, type Provider } from "@qala/core";\nexport const core: Provider[] = [provide(Database, () => new Database("postgres://u:p@localhost:5432/db"))];\n';
    const root = app(files);
    const result = generate(root);
    expect(result.diWarnings).toEqual([]);
    expect(read(root, ".qala/providers.gen.ts")).toContain("c.get<Database>(Database)");
  });

  test("static middleware of a class controller is passed to the route", () => {
    const files = { ...LAYERED };
    files["app/http/controllers/tasks.controller.ts"] = files["app/http/controllers/tasks.controller.ts"]!
      .replace('import { action, get } from "@qala/core";', 'import { action, get, securityHeaders, type Middleware } from "@qala/core";')
      .replace("  constructor(private readonly tasks: TaskService) {}", "  static middleware: Middleware[] = [securityHeaders()];\n  constructor(private readonly tasks: TaskService) {}");
    const root = app(files);
    generate(root);
    expect(read(root, ".qala/routes.gen.ts")).toContain("(x) => ({ index: x.index, latest: x.latest }), { middleware: TasksController.middleware })");
    const tsc = spawnSync(TSC, ["-p", join(root, "tsconfig.json")], { encoding: "utf8" });
    expect((tsc.stdout + tsc.stderr).trim()).toBe("");
  });

  test("(auth) folders require authentication without changing the URL", () => {
    const files = { ...LAYERED };
    const ctrl = files["app/http/controllers/tasks.controller.ts"]!;
    delete files["app/http/controllers/tasks.controller.ts"];
    files["app/http/controllers/(auth)/tasks.controller.ts"] = ctrl.replaceAll("../../application", "../../../application");
    files["app/http/controllers/(auth)/notes.controller.ts"] =
      'import { action, controller } from "@qala/core";\nexport const NotesController = controller({}, () => ({ index: action({}, () => ["n"]) }));\n';
    const root = app(files);
    const { controllers } = generate(root);
    expect(controllers.map((c) => [c.name, c.prefix, c.auth])).toEqual([
      ["notes", "/notes", true],
      ["tasks", "/tasks", true],
    ]);
    const routes = read(root, ".qala/routes.gen.ts");
    expect(routes).toContain("controller: NotesController.withAuth() }");
    expect(routes).toContain("(x) => ({ index: x.index, latest: x.latest }), { auth: true })");
  });
});
