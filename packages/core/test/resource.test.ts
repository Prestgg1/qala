import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp, Database, model, Policy, post, provide, RequestData, resource, resourceName, t } from "@qala/core";

const URL = process.env.QALA_TEST_DATABASE_URL ?? "postgres://qala:qala@localhost:5432/qala_test";

const Board = model("t_res_boards", { id: t.uuid().primary(), name: t.string() });
const Label = model("t_res_labels", {
  id: t.uuid().primary(),
  boardId: t.uuid().references(Board, { onDelete: "cascade" }),
  name: t.string({ min: 1, max: 40 }),
  color: t.string().default("gray"),
  archived: t.boolean().default(false),
  createdAt: t.datetime().now(),
});
type User = { id: string; admin: boolean };

class LabelPolicy extends Policy {
  override destroy(user: unknown): boolean {
    return (user as User | null)?.admin === true;
  }
}

const LabelsController = resource(
  Label,
  { scope: "boards/:boardId", policy: new LabelPolicy(), filters: ["color", "archived"], defaultOrder: ["name", "asc"], pageSize: 2, auth: true, name: "Label" },
  ({ table }) => ({
    archive: post("/:id/archive", {}, ({ params }) => table.update(params.id, { archived: true })),
  }),
);
const ReadOnlyBoards = resource(Board, { only: ["index", "show"] });

const db = new Database(URL, { max: 4 });
const users: Record<string, User> = { admin: { id: "a", admin: true }, member: { id: "m", admin: false } };
const app = createApp({
  controllers: [
    { name: "labels", prefix: "/boards/:boardId/labels", controller: LabelsController },
    { name: "boards", prefix: "/boards", controller: ReadOnlyBoards },
  ],
  providers: [provide(Database, () => db)],
  authenticate: async (ctx) => users[ctx.bearer() ?? ""] ?? null,
});

async function call(method: string, url: string, body?: unknown, who = "admin") {
  const headers: Record<string, string> = { authorization: `Bearer ${who}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const reply = await app.handle(new RequestData(method, url, headers, body === undefined ? "" : JSON.stringify(body), "127.0.0.1"));
  return { status: reply.status, json: reply.body === "" ? null : (JSON.parse(reply.body) as Record<string, unknown>) };
}

let boardA = "";
let boardB = "";

beforeAll(async () => {
  await db.execute("drop table if exists t_res_labels");
  await db.execute("drop table if exists t_res_boards");
  await db.execute("create table t_res_boards (id uuid primary key default gen_random_uuid(), name text not null)");
  await db.execute(
    "create table t_res_labels (id uuid primary key default gen_random_uuid(), board_id uuid not null references t_res_boards(id) on delete cascade, name text not null, color text not null default 'gray', archived boolean not null default false, created_at timestamptz not null default now())",
  );
  boardA = (await db.table(Board).insert({ name: "A" })).id;
  boardB = (await db.table(Board).insert({ name: "B" })).id;
});

afterAll(async () => {
  await db.execute("drop table if exists t_res_labels");
  await db.execute("drop table if exists t_res_boards");
  db.close();
});

describe("resource()", () => {
  test("store: 201, scope field filled from the URL, defaults from the database", async () => {
    const r = await call("POST", `/boards/${boardA}/labels`, { name: "bug", color: "red" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ boardId: boardA, name: "bug", color: "red", archived: false });
    for (const name of ["docs", "api"]) expect((await call("POST", `/boards/${boardA}/labels`, { name })).status).toBe(201);
    expect((await call("POST", `/boards/${boardB}/labels`, { name: "other" })).status).toBe(201);
  });

  test("store validates with the model's create schema", async () => {
    const r = await call("POST", `/boards/${boardA}/labels`, { color: 3 });
    expect(r.status).toBe(422);
    const paths = ((r.json?.["error"] as Record<string, unknown>)["details"] as { path: string }[]).map((d) => d.path).sort();
    expect(paths).toEqual(["color", "name"]);
  });

  test("index: paginated, scoped, ordered, filtered", async () => {
    const page1 = await call("GET", `/boards/${boardA}/labels`);
    expect(page1.status).toBe(200);
    expect((page1.json?.["data"] as { name: string }[]).map((l) => l.name)).toEqual(["api", "bug"]);
    expect(page1.json?.["meta"]).toEqual({ page: 1, pageSize: 2, total: 3, pages: 2 });
    const page2 = await call("GET", `/boards/${boardA}/labels?page=2`);
    expect((page2.json?.["data"] as { name: string }[]).map((l) => l.name)).toEqual(["docs"]);
    const red = await call("GET", `/boards/${boardA}/labels?color=red`);
    expect((red.json?.["data"] as { name: string }[]).map((l) => l.name)).toEqual(["bug"]);
    const sorted = await call("GET", `/boards/${boardA}/labels?sort=-name&pageSize=3`);
    expect((sorted.json?.["data"] as { name: string }[]).map((l) => l.name)).toEqual(["docs", "bug", "api"]);
    expect((await call("GET", `/boards/${boardA}/labels?sort=nope`)).status).toBe(422);
    expect((await call("GET", `/boards/${boardA}/labels?pageSize=500`)).status).toBe(422);
    expect((await call("GET", `/boards/${boardA}/labels?archived=maybe`)).status).toBe(422);
  });

  test("show/update/destroy: 404 for missing rows and rows of another parent, validated ids", async () => {
    const list = await call("GET", `/boards/${boardA}/labels?color=red`);
    const id = (list.json?.["data"] as { id: string }[])[0]!.id;
    expect((await call("GET", `/boards/${boardA}/labels/${id}`)).json).toMatchObject({ id, name: "bug" });
    const other = await call("GET", `/boards/${boardB}/labels/${id}`);
    expect(other.status).toBe(404);
    expect((other.json?.["error"] as Record<string, unknown>)["message"]).toBe("Label not found");
    expect((await call("GET", `/boards/${boardA}/labels/not-a-uuid`)).status).toBe(422);
    const updated = await call("PATCH", `/boards/${boardA}/labels/${id}`, { color: "orange", boardId: boardB });
    expect(updated.json).toMatchObject({ color: "orange", boardId: boardA });
    expect((await call("PATCH", `/boards/${boardA}/labels/${id}`, { name: "" })).status).toBe(422);
    expect((await call("DELETE", `/boards/${boardA}/labels/${id}`, undefined, "member")).status).toBe(403);
    expect((await call("DELETE", `/boards/${boardA}/labels/${id}`)).status).toBe(204);
    expect((await call("DELETE", `/boards/${boardA}/labels/${id}`)).status).toBe(404);
  });

  test("auth, extra actions, only", async () => {
    expect((await call("GET", `/boards/${boardA}/labels`, undefined, "nobody")).status).toBe(401);
    const id = ((await call("GET", `/boards/${boardA}/labels`)).json?.["data"] as { id: string }[])[0]!.id;
    expect((await call("POST", `/boards/${boardA}/labels/${id}/archive`)).json).toMatchObject({ id, archived: true });
    expect((await call("GET", "/boards")).json?.["meta"]).toMatchObject({ total: 2 });
    expect((await call("POST", "/boards", { name: "C" })).status).toBe(405);
    expect(app.manifest()["labels"]).toMatchObject({ index: ["GET", "/boards/:boardId/labels"], archive: ["POST", "/boards/:boardId/labels/:id/archive"] });
  });

  test("resource names", () => {
    expect(resourceName("project_labels")).toBe("Project label");
    expect(resourceName("categories")).toBe("Category");
    expect(resourceName("addresses")).toBe("Address");
  });
});

// Type level: the actions the typed client sees.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<T extends true>(_: T): void {}
type ActionsOf<C> = C extends { readonly __actions?: () => infer A } ? A : never;
expectType<Equal<keyof ActionsOf<typeof LabelsController>, "index" | "show" | "store" | "update" | "destroy" | "archive">>(true);
expectType<Equal<keyof ActionsOf<typeof ReadOnlyBoards>, "index" | "show">>(true);

test("withAuth() (controllers/(auth)/ folders) keeps the resource name and model", () => {
  const guarded = ReadOnlyBoards.withAuth();
  expect(guarded.auth).toBe(true);
  expect(guarded.resourceName).toBe("T res board");
  expect(guarded.resource?.model.table).toBe("t_res_boards");
  expect(LabelsController.resource?.filters).toEqual(["color", "archived"]);
  expect(LabelsController.resource?.hasPolicy).toBe(true);
});
