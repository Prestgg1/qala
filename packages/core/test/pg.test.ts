import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Connection, Database, DatabaseError, parseUrl } from "@qala/core";

const URL = process.env.QALA_TEST_DATABASE_URL ?? "postgres://qala:qala@localhost:5432/qala_test";

let c: Connection;

beforeAll(async () => {
  c = new Connection(parseUrl(URL));
  await c.open();
  await c.query("drop table if exists t_pg_items", []);
  await c.query("create table t_pg_items (id integer primary key, title text not null)", []);
  await c.query("insert into t_pg_items select g, 'item ' || g from generate_series(1, 300) g", []);
});

afterAll(async () => {
  await c.query("drop table if exists t_pg_items", []);
  c.close();
});

describe("prepared statements", () => {
  test("the same SQL is parsed once and reused", async () => {
    const sql = "select id, title from t_pg_items where id = $1";
    const before = c.stats.parses;
    for (let i = 1; i <= 20; i++) {
      const r = await c.queryRaw(sql, [i]);
      expect(r.rows).toEqual([[String(i), `item ${i}`]]);
    }
    expect(c.stats.parses - before).toBe(1);
    // DbRow mode reuses the columns described on first use
    const rows = (await c.query(sql, [7])).rows;
    expect(rows).toEqual([{ id: 7, title: "item 7" }]);
    expect(c.stats.parses - before).toBe(1);
  });

  test("the LRU evicts and closes old statements beyond 256", async () => {
    const closes = c.stats.closes;
    for (let i = 0; i < 260; i++) await c.queryRaw(`select ${i}::int as n`, []);
    // the 4+ evictions are sent as Close in front of later commands
    await c.queryRaw("select 1", []);
    expect(c.stats.closes - closes).toBeGreaterThanOrEqual(4);
    // an evicted statement is prepared again and still works
    const r = await c.queryRaw("select 0::int as n", []);
    expect(r.rows).toEqual([["0"]]);
  });

  test("a schema change between uses retries unprepared once", async () => {
    await c.query("drop table if exists t_pg_shape", []);
    await c.query("create table t_pg_shape (a int)", []);
    await c.query("insert into t_pg_shape values (1)", []);
    const sql = "select * from t_pg_shape";
    expect((await c.query(sql, [])).rows).toEqual([{ a: 1 }]);
    await c.query("alter table t_pg_shape add column b text default 'x'", []);
    const retries = c.stats.retries;
    expect((await c.query(sql, [])).rows).toEqual([{ a: 1, b: "x" }]);
    expect(c.stats.retries - retries).toBe(1);
    // and the next use prepares the new shape
    expect((await c.query(sql, [])).rows).toEqual([{ a: 1, b: "x" }]);
    await c.query("drop table t_pg_shape", []);
  });

  test("a failing statement is dropped from the cache", async () => {
    await expect(c.query("select * from t_pg_missing_table", [])).rejects.toBeInstanceOf(DatabaseError);
    await c.query("create table t_pg_missing_table (x int)", []);
    expect((await c.query("select * from t_pg_missing_table", [])).rows).toEqual([]);
    await c.query("drop table t_pg_missing_table", []);
  });
});

describe("pipelining", () => {
  test("50 queries in one round trip, results in order", async () => {
    const items = [];
    for (let i = 1; i <= 50; i++) items.push({ text: "select id, title from t_pg_items where id = $1", params: [i] });
    const results = await c.pipeline(items);
    expect(results.length).toBe(50);
    for (let i = 0; i < 50; i++) expect(results[i]!.rows).toEqual([[String(i + 1), `item ${i + 1}`]]);
  });

  test("an error in the middle rejects after draining; the connection stays usable", async () => {
    const items = [
      { text: "select 1::int", params: [] },
      { text: "select 1 / $1::int", params: [0] },
      { text: "insert into t_pg_items (id, title) values (1000, 'piped')", params: [] },
    ];
    let error: unknown = null;
    try {
      await c.pipeline(items);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as DatabaseError).code).toBe("22012");
    // the third item still ran (each item has its own Sync)
    expect((await c.queryRaw("select title from t_pg_items where id = 1000", [])).rows).toEqual([["piped"]]);
    expect((await c.queryRaw("select 2::int", [])).rows).toEqual([["2"]]);
  });

  test("the same new SQL twice in one pipeline", async () => {
    const sql = "select title from t_pg_items where id = $1 and id > 0";
    const rows = await c.pipeline([
      { text: sql, params: [3] },
      { text: sql, params: [4] },
    ]);
    expect(rows.map((r) => r.rows)).toEqual([[["item 3"]], [["item 4"]]]);
  });
});

describe("Database.batchRaw", () => {
  test("pool and transaction pipelines", async () => {
    const db = new Database(URL, { max: 2 });
    const out = await db.batchRaw([
      { text: "select count(*)::int from t_pg_items", params: [] },
      { text: "select title from t_pg_items where id = $1", params: [5] },
    ]);
    expect(out[1]!.rows).toEqual([["item 5"]]);
    await expect(
      db.transaction(async (tx) => {
        await tx.batchRaw([
          { text: "insert into t_pg_items (id, title) values (2000, 'tx')", params: [] },
          { text: "insert into t_pg_items (id, title) values (2000, 'dup')", params: [] },
        ]);
      }),
    ).rejects.toBeInstanceOf(DatabaseError);
    expect((await db.query("select count(*)::int as n from t_pg_items where id = 2000")).at(0)).toEqual({ n: 0 });
    db.close();
  });
});
