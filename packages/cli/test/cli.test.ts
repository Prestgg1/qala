import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkArchitecture } from "../src/check";
import { generate } from "../src/codegen";
import { makeController, makeMiddleware, makeMigration, makeModel, makeRepository, makeService, resourceNames } from "../src/make";
import { routeIdentity, routeTable, scanControllers } from "../src/scan";
import { scaffold } from "../src/scaffold";

const REPO = resolve(import.meta.dir, "../../..");
const CORE = join(REPO, "packages/core/src/index.ts");
const TSC = join(REPO, "node_modules/.bin/tsc");
const BIN = join(REPO, "packages/cli/src/bin.ts");
const coreSource = readFileSync(CORE, "utf8");
/** The model/Database API comes from the db work in @qala/core; templates using it are typechecked once it exists. */
const coreHasDb = /\bmodel\b/.test(coreSource) && /\bDatabase\b/.test(coreSource) && /\bInferModel\b/.test(coreSource);

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** A temp app whose tsconfig maps @qala/core to this repo's source. */
function app(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "qala-cli-"));
  temps.push(root);
  write(root, {
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
      include: ["app", "config", ".qala"],
    }),
    "app/.keep": "",
    ...files,
  });
  return root;
}

function typecheck(root: string): string {
  const r = spawnSync(TSC, ["-p", join(root, "tsconfig.json")], { encoding: "utf8" });
  return (r.stdout + r.stderr).trim();
}

const TASKS = `import { action, controller, created, del, get, noContent, post, t } from "@qala/core";

const id = { id: t.uuid() };

export const TasksController = controller({}, () => ({
  index: action({}, () => [{ id: "1", title: "a" }]),
  show: action({ params: id }, ({ params }) => ({ id: params.id })),
  store: action({ body: t.object({ title: t.string() }) }, ({ body }) => created(body)),
  update: action({ params: id, body: t.object({ title: t.string() }) }, ({ body }) => body),
  destroy: action({ params: id }, () => noContent()),
  complete: post("/:id/complete", {}, ({ params }) => ({ id: params.id, done: true })),
  stats: get("/stats", {}, () => ({ total: 1 })),
  purge: del("/done", {}, () => noContent()),
}));
`;

const ADMIN_USERS = `import { controller, get } from "@qala/core";

export const UsersController = controller({}, () => ({
  list: get("", {}, () => [] as string[]),
}));
`;

const USERS = `import { action, controller } from "@qala/core";

export const UsersController = controller({}, () => {
  return {
    index: action({}, () => ["ali"]),
  };
});
`;

describe("route scanning", () => {
  test("prefix and name come from the file path", () => {
    expect(routeIdentity("tasks.controller.ts")).toEqual({ prefix: "/tasks", name: "tasks" });
    expect(routeIdentity("admin/users.controller.ts")).toEqual({ prefix: "/admin/users", name: "adminUsers" });
    expect(routeIdentity("task-lists.controller.ts")).toEqual({ prefix: "/task-lists", name: "taskLists" });
  });

  test("conventional and explicit actions, nested controllers, block-bodied factories", () => {
    const root = app({
      "app/http/controllers/tasks.controller.ts": TASKS,
      "app/http/controllers/admin/users.controller.ts": ADMIN_USERS,
      "app/http/controllers/users.controller.ts": USERS,
    });
    const rows = routeTable(scanControllers(root)).map((r) => `${r.method} ${r.path} ${r.controller}.${r.action}`);
    expect(rows).toEqual([
      "GET /admin/users adminUsers.list",
      "GET /tasks tasks.index",
      "GET /tasks/:id tasks.show",
      "POST /tasks tasks.store",
      "PATCH /tasks/:id tasks.update",
      "DELETE /tasks/:id tasks.destroy",
      "POST /tasks/:id/complete tasks.complete",
      "GET /tasks/stats tasks.stats",
      "DELETE /tasks/done tasks.purge",
      "GET /users users.index",
    ]);
  });

  test("action() with a non-resource name is rejected with a hint", () => {
    const root = app({
      "app/http/controllers/tasks.controller.ts": `import { action, controller } from "@qala/core";
export const TasksController = controller({}, () => ({ search: action({}, () => []) }));
`,
    });
    expect(() => scanControllers(root)).toThrow(/tasks\.controller\.ts:2: action\(\) is only for index\/show\/store\/update\/destroy; give "search" an explicit route/);
  });

  test("duplicate routes and missing exports are reported", () => {
    const root = app({
      "app/http/controllers/a.controller.ts": `import { controller, get } from "@qala/core";
export const AController = controller({}, () => ({ one: get("/x", {}, () => 1), two: get("/x", {}, () => 2) }));
`,
      "app/http/controllers/b.controller.ts": "export const nothing = 1;\n",
    });
    expect(() => scanControllers(root)).toThrow(/route GET \/a\/x is also defined/);
    expect(() => scanControllers(root)).toThrow(/b\.controller\.ts:1: exports no controller/);
  });
});

describe("codegen", () => {
  test("writes routes.gen.ts, api.ts and main.ts that typecheck", () => {
    const root = app({
      "app/http/controllers/tasks.controller.ts": TASKS,
      "app/http/controllers/admin/users.controller.ts": ADMIN_USERS,
      "app/http/controllers/users.controller.ts": USERS,
      "app/providers.ts": 'import type { Provider } from "@qala/core";\nexport const providers: Provider[] = [];\n',
      "app/kernel.ts": 'import { cors, type ErrorHandler, type Middleware } from "@qala/core";\nexport const kernel: { middleware?: Middleware[]; onError?: ErrorHandler; exposeErrors?: boolean } = { middleware: [cors()] };\n',
      "config/app.ts": 'import { defineConfig } from "@qala/core";\nexport const config = defineConfig((env) => ({ port: env.number("PORT", 3000) }));\n',
    });
    const { written } = generate(root);
    expect(written.sort()).toEqual([".qala/api.ts", ".qala/main.ts", ".qala/routes.gen.ts"]);
    const routes = readFileSync(join(root, ".qala/routes.gen.ts"), "utf8");
    expect(routes).toContain('import { UsersController as AdminUsersController } from "../app/http/controllers/admin/users.controller";');
    expect(routes).toContain('{ name: "adminUsers", prefix: "/admin/users", controller: AdminUsersController },');
    expect(routes).toContain('{ name: "tasks", prefix: "/tasks", controller: TasksController },');
    const api = readFileSync(join(root, ".qala/api.ts"), "utf8");
    expect(api).toContain('import type { TasksController } from "../app/http/controllers/tasks.controller";');
    expect(api).toContain("  tasks: typeof TasksController;");
    expect(api).toContain('tasks: { index: ["GET", "/tasks"], show: ["GET", "/tasks/:id"], store: ["POST", "/tasks"], update: ["PATCH", "/tasks/:id"], destroy: ["DELETE", "/tasks/:id"], complete: ["POST", "/tasks/:id/complete"], stats: ["GET", "/tasks/stats"], purge: ["DELETE", "/tasks/done"] },');
    const main = readFileSync(join(root, ".qala/main.ts"), "utf8");
    expect(main).toContain('import { config } from "../config/app";');
    expect(main).toContain("  middleware: kernel.middleware,");
    expect(main).toContain("serve(app, { port: config.port });");
    expect(generate(root).written).toEqual([]); // idempotent: nothing rewritten
    expect(typecheck(root)).toBe("");
  });

  test("main.ts works without providers, kernel and config", () => {
    const root = app({ "app/http/controllers/users.controller.ts": USERS });
    generate(root);
    const main = readFileSync(join(root, ".qala/main.ts"), "utf8");
    expect(main).not.toContain("providers");
    expect(main).toContain('serve(app, { port: Number(process.env.PORT ?? "3000") });');
    expect(typecheck(root)).toBe("");
  });
});

describe("architecture check", () => {
  test("flags imports that break the dependency rule", () => {
    const root = app({
      "app/domain/task.ts": 'import { TaskService } from "../application/task.service";\nimport postgres from "postgres";\nexport type Task = { id: string };\n',
      "app/application/task.service.ts": 'import type { Task } from "../domain/task";\nimport { PgRepo } from "../infrastructure/pg";\nexport class TaskService {}\n',
      "app/infrastructure/pg.ts": 'import { TasksController } from "../http/controllers/tasks.controller";\nimport { connect } from "node:net";\nexport class PgRepo {}\n',
      "app/http/controllers/tasks.controller.ts": 'import { PgRepo } from "../../infrastructure/pg";\nimport { providers } from "../../providers";\nimport { TaskService } from "../../application/task.service";\nexport const TasksController = 1;\n',
      "app/providers.ts": 'import { PgRepo } from "./infrastructure/pg";\nexport const providers = [];\n',
    });
    const { violations } = checkArchitecture(root);
    const found = violations.map((v) => `${v.file}:${v.line} ${v.layer}->${v.target}`);
    expect(found).toEqual([
      "app/application/task.service.ts:2 application->app/infrastructure/pg.ts",
      "app/domain/task.ts:1 domain->app/application/task.service.ts",
      "app/domain/task.ts:2 domain->postgres",
      "app/http/controllers/tasks.controller.ts:1 http->app/infrastructure/pg.ts",
      "app/http/controllers/tasks.controller.ts:2 http->app/providers.ts",
      "app/infrastructure/pg.ts:1 infrastructure->app/http/controllers/tasks.controller.ts",
    ]);
    expect(violations[3]!.message).toContain("controllers call application services; never repositories");
  });

  test("a clean app passes", () => {
    const root = app({
      "app/domain/task.ts": 'import { t } from "@qala/core";\nexport const TaskInput = t.object({ title: t.string() });\n',
      "app/application/task.service.ts": 'import { TaskInput } from "../domain/task";\nexport class TaskService {}\n',
      "app/infrastructure/pg.ts": 'import { connect } from "node:net";\nimport { TaskService } from "../application/task.service";\n',
      "app/http/controllers/tasks.controller.ts": 'import { TaskService } from "../../application/task.service";\nimport type { TaskInput } from "../../domain/task";\n',
    });
    expect(checkArchitecture(root).violations).toEqual([]);
  });
});

describe("make:*", () => {
  test("resource names", () => {
    expect(resourceNames("tasks")).toEqual({ Entity: "Task", entity: "task", entities: "tasks", file: "task", pluralFile: "tasks", table: "tasks" });
    expect(resourceNames("TaskList")).toMatchObject({ Entity: "TaskList", entities: "taskLists", file: "task-list", table: "task_lists" });
    expect(resourceNames("category")).toMatchObject({ entities: "categories", table: "categories" });
  });

  test("controller, service, middleware and migration typecheck and pass the architecture check", () => {
    const root = app({ "app/providers.ts": 'import type { Provider } from "@qala/core";\n\nexport const providers: Provider[] = [\n];\n' });
    makeController(root, "greetings", false);
    makeController(root, "notes", true);
    makeController(root, "admin/reports", false);
    makeService(root, "greeting");
    makeMiddleware(root, "auth");
    expect(makeMigration(root, "create_notes").created).toEqual(["database/migrations/0001_create_notes.sql"]);
    expect(makeMigration(root, "add index").created).toEqual(["database/migrations/0002_add_index.sql"]);
    expect(readFileSync(join(root, "database/migrations/0001_create_notes.sql"), "utf8")).toContain("create table notes");
    const providers = readFileSync(join(root, "app/providers.ts"), "utf8");
    expect(providers).toContain("singleton(GreetingService, () => new GreetingService()),");
    expect(providers).toContain('import { GreetingService } from "./application/greeting.service";');
    expect(providers).toContain('import { type Provider, singleton } from "@qala/core";');
    generate(root);
    expect(typecheck(root)).toBe("");
    expect(checkArchitecture(root).violations).toEqual([]);
    expect(() => makeController(root, "notes", true)).toThrow(/already exists/);
  });

  test.skipIf(!coreHasDb)("model → repository → service → resource controller is a working vertical slice", () => {
    const root = app({ "app/providers.ts": 'import type { Provider } from "@qala/core";\n\nexport const providers: Provider[] = [\n];\n' });
    makeModel(root, "task");
    makeRepository(root, "task");
    makeService(root, "task");
    makeController(root, "tasks", true);
    const controller = readFileSync(join(root, "app/http/controllers/tasks.controller.ts"), "utf8");
    expect(controller).toContain("controller({ tasks: TaskService }, ({ tasks }) => ({");
    const providers = readFileSync(join(root, "app/providers.ts"), "utf8");
    expect(providers).toContain("singleton(TaskRepository, (c) => new PgTaskRepository(c.get(Database))),");
    expect(providers).toContain("singleton(TaskService, (c) => new TaskService(c.get(TaskRepository))),");
    generate(root);
    expect(typecheck(root)).toBe("");
    expect(checkArchitecture(root).violations).toEqual([]);
  });
});

describe("qala new", () => {
  test("scaffolds an app that generates, typechecks and passes check", () => {
    const parent = mkdtempSync(join(tmpdir(), "qala-new-"));
    temps.push(parent);
    const dir = join(parent, "My App");
    const files = scaffold(dir, { corePath: CORE });
    expect(files).toContain("app/http/controllers/health.controller.ts");
    const tsconfig = JSON.parse(readFileSync(join(dir, "tsconfig.json"), "utf8")) as { compilerOptions: { paths: Record<string, string[]>; typeRoots?: string[] } };
    expect(tsconfig.compilerOptions.paths["@qala/core"]![0]).toEndWith("packages/core/src/index.ts");
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name).toBe("my-app");
    tsconfig.compilerOptions.typeRoots = [join(REPO, "node_modules/@types")];
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
    const { controllers } = generate(dir);
    expect(controllers.map((c) => c.name)).toEqual(["health"]);
    expect(typecheck(dir)).toBe("");
    expect(checkArchitecture(dir).violations).toEqual([]);
    expect(() => scaffold(dir)).toThrow(/not empty/);
  });
});

describe("bin", () => {
  test("qala routes / check / help run from inside an app", () => {
    const root = app({ "app/http/controllers/tasks.controller.ts": TASKS, "app/domain/x.ts": 'import "../infrastructure/y";\n', "app/infrastructure/y.ts": "export {};\n" });
    const run = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: join(root, "app"), encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    const routes = run("routes");
    expect(routes.status).toBe(0);
    expect(routes.stdout).toContain("POST   /tasks/:id/complete  tasks.complete");
    const check = run("check");
    expect(check.status).toBe(1);
    expect(check.stderr).toContain("app/domain/x.ts:1  domain must not import infrastructure");
    expect(run("help").stdout).toContain("make:controller <name> [--resource]");
    const unknown = run("nope");
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('Unknown command "nope"');
    expect(existsSync(join(root, ".qala"))).toBe(false); // routes/check never write
  });
});
