import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { AuditSink, bindEvents, Container, Database, type ModelChange, model, on, RealtimeSink, resetEvents, singleton, t } from "@qala/core";

const URL = process.env.QALA_TEST_DATABASE_URL ?? "postgres://qala:qala@localhost:5432/qala_test";
const db = new Database(URL, { max: 4 });

const Note = model("ev_notes", { id: t.uuid(), title: t.string(), done: t.boolean(), projectId: t.uuid() });
const Plain = model("ev_plain", { id: t.uuid(), title: t.string() });
const Logged = model("ev_logged", { id: t.uuid(), title: t.string(), projectId: t.uuid() }, { audit: true, realtime: (row) => ({ projectId: row.projectId }) });

const P = "40000000-0000-4000-8000-000000000001";

class MemoryAudit extends AuditSink {
  readonly entries: string[] = [];
  record(change: ModelChange): Promise<void> {
    const before = change.before as { title: string } | null;
    const row = change.row as { title: string };
    this.entries.push(`${change.table} ${change.kind} ${before === null ? "-" : before.title} -> ${row.title}`);
    return Promise.resolve();
  }
}

class MemoryRealtime extends RealtimeSink {
  readonly published: string[] = [];
  publish(change: ModelChange, scope: unknown): Promise<void> {
    this.published.push(`${change.kind} ${JSON.stringify(scope)}`);
    return Promise.resolve();
  }
}

class Inbox {
  readonly lines: string[] = [];
}

const audit = new MemoryAudit();
const realtime = new MemoryRealtime();
const inbox = new Inbox();

beforeAll(async () => {
  await db.execute("drop table if exists ev_notes, ev_plain, ev_logged");
  await db.execute("create table ev_notes (id uuid primary key default gen_random_uuid(), title text not null, done boolean not null default false, project_id uuid not null)");
  await db.execute("create table ev_plain (id uuid primary key default gen_random_uuid(), title text not null)");
  await db.execute("create table ev_logged (id uuid primary key default gen_random_uuid(), title text not null, project_id uuid not null)");
});

afterAll(async () => {
  await db.execute("drop table if exists ev_notes, ev_plain, ev_logged");
  resetEvents();
  db.close();
});

beforeEach(() => {
  resetEvents();
  bindEvents(new Container([singleton(AuditSink, () => audit), singleton(RealtimeSink, () => realtime), singleton(Inbox, () => inbox)]));
  inbox.lines.length = 0;
  audit.entries.length = 0;
  realtime.published.length = 0;
});

describe("model events", () => {
  test("created / updated (with the row before) / deleted, with services from the container", async () => {
    on(Note, "created", (note, ctx) => {
      ctx.service(Inbox).lines.push(`created ${note.title}`);
    });
    on(Note, "updated", (note, before, ctx) => {
      ctx.service(Inbox).lines.push(`updated ${before.title} -> ${note.title} done=${note.done}`);
    });
    on(Note, "deleted", async (note, ctx) => {
      await Promise.resolve();
      ctx.service(Inbox).lines.push(`deleted ${note.title}`);
    });
    const notes = db.table(Note);
    const n = await notes.insert({ title: "draft", projectId: P });
    await notes.update(n.id, { title: "final", done: true });
    expect(await notes.delete(n.id)).toBe(true);
    expect(await notes.delete(n.id)).toBe(false);
    expect(await notes.update(n.id, { title: "gone" })).toBeNull();
    expect(inbox.lines).toEqual(["created draft", "updated draft -> final done=true", "deleted final"]);
  });

  test("in a transaction: dispatched after COMMIT, dropped on ROLLBACK", async () => {
    on(Note, "created", (note, ctx) => {
      ctx.service(Inbox).lines.push(`created ${note.title}`);
    });
    await db.transaction(async (tx) => {
      await tx.table(Note).insert({ title: "inside", projectId: P });
      expect(inbox.lines).toEqual([]);
    });
    expect(inbox.lines).toEqual(["created inside"]);
    await expect(
      db.transaction(async (tx) => {
        await tx.table(Note).insert({ title: "rolled back", projectId: P });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(inbox.lines).toEqual(["created inside"]);
  });

  test("a failing handler is logged; the write and the other handlers still happen", async () => {
    on(Note, "created", () => {
      throw new Error("boom");
    });
    on(Note, "created", (note, ctx) => {
      ctx.service(Inbox).lines.push(`second saw ${note.title}`);
    });
    const row = await db.table(Note).insert({ title: "kept", projectId: P });
    expect(row.title).toBe("kept");
    expect(inbox.lines).toEqual(["second saw kept"]);
  });

  test("models without handlers or options do no extra work", async () => {
    const row = await db.table(Plain).insert({ title: "quiet" });
    expect(await db.table(Plain).update(row.id, { title: "still quiet" })).toEqual({ id: row.id, title: "still quiet" });
    expect(inbox.lines).toEqual([]);
  });

  test("audit and realtime model options go to the app's sinks", async () => {
    const logged = db.table(Logged);
    const row = await logged.insert({ title: "a", projectId: P });
    await logged.update(row.id, { title: "b" });
    await logged.delete(row.id);
    expect(audit.entries).toEqual(["ev_logged created - -> a", "ev_logged updated a -> b", "ev_logged deleted - -> b"]);
    expect(realtime.published).toEqual([`created {"projectId":"${P}"}`, `updated {"projectId":"${P}"}`, `deleted {"projectId":"${P}"}`]);
  });
});
