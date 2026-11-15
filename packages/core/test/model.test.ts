import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database, model, t, validate, type InferCreate, type InferModel, type InferUpdate } from "@qala/core";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<T extends true>(_: T): void {}

const URL = process.env.QALA_TEST_DATABASE_URL ?? "postgres://qala:qala@localhost:5432/qala_test";

const Project = model("t_model_projects", {
  id: t.uuid().primary(),
  name: t.string({ min: 1, max: 100 }).unique(),
});

const Task = model("t_model_tasks", {
  id: t.uuid().primary(),
  title: t.string({ min: 1 }),
  done: t.boolean().default(false),
  priority: t.integer().default(1).index(),
  note: t.string().nullable(),
  projectId: t.uuid().references(Project, { onDelete: "cascade" }),
  parentId: t.uuid().nullable().referencesSelf(),
  createdAt: t.datetime().now(),
});
type Task = InferModel<typeof Task>;

describe("model as the source of truth", () => {
  test("row, create and update types", () => {
    expectType<Equal<Task, { id: string; title: string; done: boolean; priority: number; note: string | null; projectId: string; parentId: string | null; createdAt: string }>>(true);
    expectType<Equal<InferCreate<typeof Task>, { title: string; projectId: string; id?: string; done?: boolean; priority?: number; note?: string | null; parentId?: string | null; createdAt?: string }>>(true);
    expectType<Equal<InferUpdate<typeof Task>, { title?: string; done?: boolean; priority?: number; note?: string | null; projectId?: string; parentId?: string | null; createdAt?: string }>>(true);
    // A model without defaults keeps the permissive insert type of older versions.
    const Legacy = model("t_legacy", { id: t.uuid(), name: t.string() });
    expectType<Equal<InferCreate<typeof Legacy>, Partial<{ id: string; name: string }>>>(true);
  });

  test("column metadata", () => {
    const col = (key: string) => Task.fields[Task.indexOf(key)]!.column;
    expect(Task.primaryKey).toBe("id");
    expect(Task.primaryColumn).toBe("id");
    expect(col("id").defaultExpr).toBe("gen_random_uuid()");
    expect(col("done").defaultExpr).toBe("false");
    expect(col("priority").isIndexed).toBe(true);
    expect(col("createdAt").defaultExpr).toBe("now()");
    expect([col("projectId").refTable, col("projectId").refColumn, col("projectId").onDelete]).toEqual(["t_model_projects", "id", "cascade"]);
    expect([col("parentId").refTable, col("parentId").refColumn]).toEqual(["t_model_tasks", "id"]);
    expect(Task.nullable).toEqual([false, false, false, false, true, false, true, false]);
    expect(t.string().default("it's").column.defaultExpr).toBe("'it''s'");
    expect(model("t_x", { key: t.string().primary(), v: t.string() }).primaryKey).toBe("key");
  });

  test("createSchema: defaults and nullable columns are optional, the rest required", () => {
    expect(validate(Task.createSchema, { title: "a", projectId: "0b4c7f1e-6b61-4a3c-9d1e-2f6a4f1d2c3b" }).ok).toBe(true);
    const bad = validate(Task.createSchema, { done: "yes" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.map((i) => i.path).sort()).toEqual(["done", "projectId", "title"]);
  });

  test("updateSchema: everything optional, no primary key", () => {
    expect(validate(Task.updateSchema, {}).ok).toBe(true);
    expect(validate(Task.updateSchema, { done: true }).ok).toBe(true);
    expect(Task.updateSchema.keys).not.toContain("id");
    expect(validate(Task.updateSchema, { title: "" }).ok).toBe(false);
  });

  test("modifiers keep validation and decoding", () => {
    expect(validate(Task.fields[Task.indexOf("note")]!, null).ok).toBe(true);
    expect(validate(Task.fields[Task.indexOf("title")]!, null).ok).toBe(false);
  });
});

describe("inserts with database defaults", () => {
  const db = new Database(URL, { max: 2 });
  beforeAll(async () => {
    await db.execute("drop table if exists t_model_tasks");
    await db.execute("drop table if exists t_model_projects");
    await db.execute("create table t_model_projects (id uuid primary key default gen_random_uuid(), name text not null unique)");
    await db.execute(
      "create table t_model_tasks (id uuid primary key default gen_random_uuid(), title text not null, done boolean not null default false, priority integer not null default 1, note text, project_id uuid not null references t_model_projects(id) on delete cascade, parent_id uuid references t_model_tasks(id), created_at timestamptz not null default now())",
    );
  });
  afterAll(async () => {
    await db.execute("drop table if exists t_model_tasks");
    await db.execute("drop table if exists t_model_projects");
    db.close();
  });

  test("the database fills defaults", async () => {
    const p = await db.table(Project).insert({ name: "Qala" });
    const row = await db.table(Task).insert({ title: "Write docs", projectId: p.id });
    expect(row.done).toBe(false);
    expect(row.priority).toBe(1);
    expect(row.note).toBeNull();
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    // Services declare InferCreate<typeof Task> for strict input; the table itself accepts a partial row.
    const input: InferCreate<typeof Task> = { title: "Typed", projectId: p.id };
    expect((await db.table(Task).insert(input)).title).toBe("Typed");
    const updated = await db.table(Task).update(row.id, { done: true });
    expect(updated?.done).toBe(true);
  });
});
