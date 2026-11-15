import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ApiError } from "@qala/client";
import { action, controller, created, Database, get, model, NotFoundError, singleton, t, type InferModel } from "@qala/core";
import { testApp, withRollback } from "@qala/core/testing";

class Notes {
  private items = new Map<string, { id: string; text: string }>();
  add(text: string) {
    const n = { id: String(this.items.size + 1), text };
    this.items.set(n.id, n);
    return n;
  }
  find(id: string) {
    const n = this.items.get(id);
    if (n === undefined) throw new NotFoundError("Note not found");
    return n;
  }
}

const NotesController = controller({ notes: Notes }, ({ notes }) => ({
  show: action({ params: { id: t.string() } }, ({ params }) => notes.find(params.id)),
  store: action({ body: t.object({ text: t.string() }) }, ({ body }) => created(notes.add(body.text))),
  me: get("/me", {}, ({ ctx }) => ({ auth: ctx.header("authorization") ?? null })),
}));
type Api = { notes: typeof NotesController };

describe("testApp", () => {
  const { client, get: resolve } = testApp<Api>({
    controllers: [{ name: "notes", prefix: "/notes", controller: NotesController }],
    providers: [singleton(Notes, () => new Notes())],
    headers: { authorization: "Bearer t" },
  });

  test("typed calls run in-process", async () => {
    const note = await client.notes.store({ body: { text: "hi" } });
    expect(note.text).toBe("hi");
    expect(await client.notes.show({ params: { id: note.id } })).toEqual(note);
    expect(resolve(Notes).find(note.id).text).toBe("hi");
  });

  test("errors surface as ApiError, headers are sent", async () => {
    const err = await client.notes.show({ params: { id: "nope" } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect(await client.notes.me()).toEqual({ auth: "Bearer t" });
  });
});

const Item = model("t_testing_items", { id: t.integer(), name: t.string() });
type Item = InferModel<typeof Item>;
const URL = process.env.QALA_TEST_DATABASE_URL ?? "postgres://qala:qala@localhost:5432/qala_test";

describe("withRollback", () => {
  const db = new Database(URL, { max: 2 });
  beforeAll(async () => {
    await db.execute("drop table if exists t_testing_items");
    await db.execute("create table t_testing_items (id serial primary key, name text not null)");
  });
  afterAll(async () => {
    await db.execute("drop table if exists t_testing_items");
    db.close();
  });

  test("changes are visible inside and gone after", async () => {
    const inside = await withRollback(db, async (tx) => {
      await tx.table(Item).insert({ name: "a" });
      return (await tx.table(Item).all()).length;
    });
    expect(inside).toBe(1);
    expect(await db.table(Item).all()).toHaveLength(0);
  });

  test("errors from the test body propagate, still rolled back", async () => {
    const run = withRollback(db, async (tx) => {
      await tx.table(Item).insert({ name: "b" });
      throw new Error("boom");
    });
    await expect(run).rejects.toThrow("boom");
    expect(await db.table(Item).all()).toHaveLength(0);
  });
});
