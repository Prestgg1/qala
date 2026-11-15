import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "@qala/core";

const URL = process.env.QALA_TEST_DATABASE_URL ?? "postgres://qala:qala@localhost:5432/qala_test";

const db = new Database(URL);
const admin = new Database(URL);

afterAll(() => {
  db.close();
  admin.close();
});

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("listen / notify", () => {
  test("receives a payload", async () => {
    const got: string[] = [];
    const sub = await db.listen("t_one", (p) => got.push(p));
    await db.notify("t_one", "hello");
    await db.notify("t_one", "wörld \"quoted\"");
    await until(() => got.length === 2);
    expect(got).toEqual(["hello", "wörld \"quoted\""]);
    await sub.unlisten();
  });

  test("two channels share one connection", async () => {
    const a: string[] = [];
    const b: string[] = [];
    const s1 = await db.listen("t_a", (p) => a.push(p));
    const pid = db.listenerPid();
    const s2 = await db.listen("t_b", (p) => b.push(p));
    expect(db.listenerPid()).toBe(pid);
    await db.notify("t_a", "1");
    await db.notify("t_b", "2");
    await db.notify("t_a", "3");
    await until(() => a.length === 2 && b.length === 1);
    expect(a).toEqual(["1", "3"]);
    expect(b).toEqual(["2"]);
    await s1.unlisten();
    await s2.unlisten();
  });

  test("unlisten stops delivery, other handlers keep working", async () => {
    const x: string[] = [];
    const y: string[] = [];
    const sx = await db.listen("t_un", (p) => x.push(p));
    const sy = await db.listen("t_un", (p) => y.push(p));
    await db.notify("t_un", "1");
    await until(() => x.length === 1 && y.length === 1);
    await sx.unlisten();
    await db.notify("t_un", "2");
    await until(() => y.length === 2);
    expect(x).toEqual(["1"]);
    await sy.unlisten();
    await db.notify("t_un", "3");
    await new Promise((r) => setTimeout(r, 150));
    expect(y).toEqual(["1", "2"]);
  });

  test("notifications interleaved with queries on the listener's own session", async () => {
    const got: string[] = [];
    const sub = await db.listen("t_mix", (p) => got.push(p));
    // notify inside a transaction that also runs queries; delivered at commit
    await admin.transaction(async (tx) => {
      await tx.query("select pg_notify('t_mix', 'a')", []);
      await tx.query("select pg_notify('t_mix', 'b')", []);
    });
    await until(() => got.length === 2);
    expect(got).toEqual(["a", "b"]);
    await sub.unlisten();
  });

  test("reconnects and listens again after the connection is terminated", async () => {
    const got: string[] = [];
    const other: string[] = [];
    const s1 = await db.listen("t_re1", (p) => got.push(p));
    const s2 = await db.listen("t_re2", (p) => other.push(p));
    const pid = db.listenerPid();
    expect(pid).toBeGreaterThan(0);
    await admin.query("select pg_terminate_backend($1)", [pid]);
    await until(() => db.listenerPid() !== 0 && db.listenerPid() !== pid);
    await db.notify("t_re1", "after");
    await db.notify("t_re2", "after2");
    await until(() => got.length === 1 && other.length === 1);
    expect(got).toEqual(["after"]);
    expect(other).toEqual(["after2"]);
    await s1.unlisten();
    await s2.unlisten();
  });
});
