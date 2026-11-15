import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { batch, Database, run } from "@qala/core";
import { compileQuery } from "@qala/core/query";
import { render } from "./fixtures/orm/generate";
import { Queries } from "./fixtures/orm/queries.gen";
import * as declared from "./fixtures/orm/queries";

const URL = process.env.QALA_TEST_DATABASE_URL ?? "postgres://qala:qala@localhost:5432/qala_test";
const db = new Database(URL, { max: 4 });

const P1 = "10000000-0000-4000-8000-000000000001";
const P2 = "10000000-0000-4000-8000-000000000002";
const P3 = "10000000-0000-4000-8000-000000000003";
const T = (n: number) => `20000000-0000-4000-8000-00000000000${n}`;
const C = (n: number) => `30000000-0000-4000-8000-00000000000${n}`;

beforeAll(async () => {
  await db.execute("drop table if exists orm_reactions, orm_comments, orm_tasks, orm_projects");
  await db.execute("create table orm_projects (name text not null, archived boolean not null default false, id uuid primary key)");
  // Columns in a different order than the model: the compiler always names its columns.
  await db.execute(`create table orm_tasks (
    created_at timestamptz not null default now(), id uuid primary key default gen_random_uuid(),
    title text not null unique, project_id uuid not null references orm_projects(id), status text not null,
    priority int not null, estimate double precision, due_at timestamptz)`);
  await db.execute("create table orm_comments (id uuid primary key, task_id uuid not null references orm_tasks(id) on delete cascade, body text not null, created_at timestamptz not null)");
  await db.execute("create table orm_reactions (id uuid primary key default gen_random_uuid(), comment_id uuid not null references orm_comments(id) on delete cascade, emoji text not null)");
  await db.execute(`insert into orm_projects (id, name, archived) values ('${P1}', 'Alpha', false), ('${P2}', 'Beta', false), ('${P3}', 'Old', true)`);
  await db.execute(`insert into orm_tasks (id, project_id, title, status, priority, estimate, due_at, created_at) values
    ('${T(1)}', '${P1}', 'Design API', 'doing', 3, 2.5, '2026-11-20 10:00:00+00', '2026-11-01 08:00:00.5+00'),
    ('${T(2)}', '${P1}', 'Write docs', 'todo', 1, null, null, '2026-11-02 08:00:00+00'),
    ('${T(3)}', '${P1}', 'Ship it', 'todo', 3, 1, '2026-11-30 00:00:00+00', '2026-11-03 08:00:00+00'),
    ('${T(4)}', '${P2}', 'Beta plan', 'done', 2, null, null, '2026-11-04 08:00:00+00')`);
  await db.execute(`insert into orm_comments (id, task_id, body, created_at) values
    ('${C(1)}', '${T(1)}', 'first', '2026-11-05 08:00:00+00'),
    ('${C(2)}', '${T(1)}', 'second', '2026-11-06 08:00:00+00'),
    ('${C(3)}', '${T(3)}', 'ship!', '2026-11-07 08:00:00+00')`);
  await db.execute(`insert into orm_reactions (comment_id, emoji) values ('${C(1)}', '👍'), ('${C(1)}', '🎉'), ('${C(3)}', '🚀')`);
});

afterAll(async () => {
  await db.execute("drop table if exists orm_reactions, orm_comments, orm_tasks, orm_projects");
  db.close();
});

describe("compiler", () => {
  test("the committed queries.gen.ts is up to date", () => {
    expect(readFileSync(join(import.meta.dir, "fixtures/orm/queries.gen.ts"), "utf8")).toBe(render());
  });

  test("optional filters compile to static SQL", () => {
    const plan = compileQuery(declared.projectTasks);
    expect(plan.statements[0]!.sql).toBe(
      'select "t"."id", "t"."title", "t"."status", "t"."estimate", "t"."due_at", "t"."project_id", "t"."id" from "orm_tasks" as "t" where ("t"."project_id" = $1::uuid and ($2::text is null or "t"."status" = $2::text) and ($3::text is null or "t"."title" ilike $3::text)) order by "t"."priority" desc, "t"."title" asc limit $4::int4',
    );
    expect(plan.statements[0]!.params.map((p) => p.name)).toEqual(["projectId", "status", "q", "limit"]);
  });

  test("each relation level is one statement keyed by the parent's key set", () => {
    const plan = compileQuery(declared.projectTasks);
    expect(plan.statements.length).toBe(4);
    expect(plan.levels.map((l) => l.cardinality)).toEqual(["root", "one", "many", "many"]);
    expect(plan.statements[3]!.sql).toContain('where "re"."comment_id" in (select "c"."id" from "orm_comments" as "c" where "c"."task_id" in (select "t"."id" from "orm_tasks"');
  });

  test("every compiled statement", () => {
    const all: Record<string, string[]> = {};
    for (const [name, def] of Object.entries(declared)) all[name] = compileQuery(def).statements.map((s) => s.sql);
    expect(all).toMatchSnapshot();
  });
});

describe("run", () => {
  test("nested relations in one round trip, typed", async () => {
    const tasks = await run(db, Queries.projectTasks, { projectId: P1 });
    expect(tasks).toEqual([
      {
        id: T(1),
        title: "Design API",
        status: "doing",
        estimate: 2.5,
        dueAt: "2026-11-20T10:00:00.000Z",
        project: { id: P1, name: "Alpha" },
        comments: [
          { id: C(1), body: "first", reactions: [{ emoji: "🎉" }, { emoji: "👍" }] },
          { id: C(2), body: "second", reactions: [] },
        ],
      },
      { id: T(3), title: "Ship it", status: "todo", estimate: 1, dueAt: "2026-11-30T00:00:00.000Z", project: { id: P1, name: "Alpha" }, comments: [{ id: C(3), body: "ship!", reactions: [{ emoji: "🚀" }] }] },
      { id: T(2), title: "Write docs", status: "todo", estimate: null, dueAt: null, project: { id: P1, name: "Alpha" }, comments: [] },
    ]);
  });

  test("optional filters apply only when given; limit applies to every level", async () => {
    expect((await run(db, Queries.projectTasks, { projectId: P1, status: "todo" })).map((t) => t.title)).toEqual(["Ship it", "Write docs"]);
    expect((await run(db, Queries.projectTasks, { projectId: P1, q: "%doc%" })).map((t) => t.title)).toEqual(["Write docs"]);
    const limited = await run(db, Queries.projectTasks, { projectId: P1, limit: 1, status: null });
    expect(limited.map((t) => [t.title, t.comments.length])).toEqual([["Design API", 2]]);
  });

  test("array parameters, whole rows", async () => {
    const rows = await run(db, Queries.tasksByIds, { ids: [T(4), T(2)] });
    expect(rows).toEqual([
      { id: T(4), projectId: P2, title: "Beta plan", status: "done", priority: 2, estimate: null, dueAt: null, createdAt: "2026-11-04T08:00:00.000Z" },
      { id: T(2), projectId: P1, title: "Write docs", status: "todo", priority: 1, estimate: null, dueAt: null, createdAt: "2026-11-02T08:00:00.000Z" },
    ]);
    expect(await run(db, Queries.tasksByIds, { ids: [] })).toEqual([]);
  });

  test("aggregates", async () => {
    expect(await run(db, Queries.statusSummary, { projectId: P1 })).toEqual([
      { status: "doing", tasks: 1, priority: 3, latest: "2026-11-01T08:00:00.500Z" },
      { status: "todo", tasks: 2, priority: 4, latest: "2026-11-03T08:00:00.000Z" },
    ]);
  });

  test("left join columns are nullable", async () => {
    const rows = await run(db, Queries.projectTaskTitles, {});
    expect(rows).toEqual([
      { project: "Alpha", title: "Design API", priority: 3 },
      { project: "Alpha", title: "Ship it", priority: 3 },
      { project: "Alpha", title: "Write docs", priority: 1 },
      { project: "Beta", title: "Beta plan", priority: 2 },
    ]);
    await db.execute(`insert into orm_projects (id, name) values ('10000000-0000-4000-8000-000000000009', 'Empty')`);
    const withEmpty = await run(db, Queries.projectTaskTitles, {});
    expect(withEmpty[withEmpty.length - 1]).toEqual({ project: "Empty", title: null, priority: null });
    await db.execute("delete from orm_projects where name = 'Empty'");
  });

  test("exists / not exists", async () => {
    expect(await run(db, Queries.quietTasks, { minPriority: 3 })).toEqual([{ title: "Beta plan" }, { title: "Design API" }, { title: "Ship it" }, { title: "Write docs" }]);
    expect(await run(db, Queries.quietTasks, { minPriority: 9 })).toEqual([{ title: "Beta plan" }, { title: "Write docs" }]);
  });

  test("first() is a row or null", async () => {
    expect(await run(db, Queries.topTask, { projectId: P1 })).toEqual({ id: T(1), title: "Design API" });
    expect(await run(db, Queries.topTask, { projectId: P3 })).toBeNull();
  });

  test("mutations with returning, and affected counts", async () => {
    const [created] = await run(db, Queries.createTask, { projectId: P2, title: "New one", priority: 2 });
    expect(created!.title).toBe("New one");
    expect(created!.status).toBe("todo");
    expect(created!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(await run(db, Queries.setStatus, { id: created!.id, status: "done" })).toEqual([{ id: created!.id, status: "done" }]);
    expect(await run(db, Queries.deleteTask, { id: created!.id })).toBe(1);
    expect(await run(db, Queries.deleteTask, { id: created!.id })).toBe(0);
  });

  test("batch: several queries, one round trip, typed by name", async () => {
    const { tasks, summary, top, none } = await batch(db, {
      tasks: [Queries.projectTasks, { projectId: P2 }],
      summary: [Queries.statusSummary, { projectId: P2 }],
      top: [Queries.topTask, { projectId: P1 }],
      none: [Queries.topTask, { projectId: P3 }],
    });
    expect(tasks.map((t) => t.title)).toEqual(["Beta plan"]);
    expect(summary).toEqual([{ status: "done", tasks: 1, priority: 2, latest: "2026-11-04T08:00:00.000Z" }]);
    expect(top?.title).toBe("Design API");
    expect(none).toBeNull();
  });

  test("works inside transactions (rolled back on error)", async () => {
    await expect(
      db.transaction(async (tx) => {
        await run(tx, Queries.createTask, { projectId: P2, title: "Temp", priority: 1 });
        const { inside } = await batch(tx, { inside: [Queries.tasksByIds, { ids: [] }] });
        expect(inside).toEqual([]);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect((await db.query("select count(*)::int as n from orm_tasks where title = 'Temp'"))[0]!["n"]).toBe(0);
  });
});
