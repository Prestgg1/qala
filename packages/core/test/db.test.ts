import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database, DatabaseError, migrate, migrationStatus, MIGRATION_LOCK_KEY, model, parseMigration, rollback, NotFoundError, splitStatements, t, toIso, type InferModel } from "@qala/core";

const URL = process.env.QALA_TEST_DATABASE_URL ?? "postgres://qala:qala@localhost:5432/qala_test";

const Item = model("t_db_items", {
  id: t.integer(),
  name: t.string(),
  active: t.boolean(),
  price: t.nullable(t.number()),
  createdAt: t.datetime(),
});
type Item = InferModel<typeof Item>;

const db = new Database(URL, { max: 4 });
const items = db.table(Item);

beforeAll(async () => {
  await db.execute("drop table if exists t_db_items");
  await db.execute("create table t_db_items (id serial primary key, name text not null unique, active boolean not null default true, price double precision, created_at timestamptz not null default now())");
});

afterAll(async () => {
  await db.execute("drop table if exists t_db_items");
  await db.execute("drop table if exists t_db_migrated");
  await db.execute("delete from qala_migrations where name like 't_db_%'");
  db.close();
});

describe("Table", () => {
  test("insert returns the stored, decoded row", async () => {
    const a: Item = await items.insert({ name: "apple", price: 1.25 });
    expect(a.id).toBeGreaterThan(0);
    expect(a.name).toBe("apple");
    expect(a.active).toBe(true);
    expect(a.price).toBe(1.25);
    expect(a.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("where, orderBy, limit, offset, count", async () => {
    await items.insert({ name: "banana", active: false });
    await items.insert({ name: "cherry", price: 3 });
    expect((await items.all({ where: { active: true }, orderBy: ["name", "asc"] })).map((i) => i.name)).toEqual(["apple", "cherry"]);
    expect((await items.all({ orderBy: ["name", "desc"], limit: 1, offset: 1 })).map((i) => i.name)).toEqual(["banana"]);
    expect((await items.all({ where: { price: null } })).map((i) => i.name)).toEqual(["banana"]);
    expect(await items.count()).toBe(3);
    expect(await items.count({ active: false })).toBe(1);
    expect((await items.first({ name: "cherry" }))?.price).toBe(3);
    expect(await items.first({ name: "nope" })).toBeNull();
  });

  test("find, findOrFail, update, delete", async () => {
    const banana = await items.first({ name: "banana" });
    expect(banana).not.toBeNull();
    const id = banana!.id;
    expect((await items.find(id))?.name).toBe("banana");
    expect(await items.find(99999)).toBeNull();
    expect(items.findOrFail(99999)).rejects.toBeInstanceOf(NotFoundError);
    const updated = await items.update(id, { active: true, price: 2 });
    expect(updated?.active).toBe(true);
    expect(updated?.price).toBe(2);
    expect(await items.update(99999, { price: 1 })).toBeNull();
    expect(await items.delete(id)).toBe(true);
    expect(await items.delete(id)).toBe(false);
  });

  test("unknown fields are rejected", async () => {
    expect(items.all({ where: { nope: 1 } as unknown as Partial<Item> })).rejects.toThrow(/unknown field "nope"/);
  });

  test("unique violation is a DatabaseError with its SQLSTATE", async () => {
    try {
      await items.insert({ name: "apple" });
      throw new Error("expected a unique violation");
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseError);
      expect((error as DatabaseError).code).toBe("23505");
    }
  });

  test("raw query and execute with parameters", async () => {
    const rows = await db.query("select name from t_db_items where price > $1 order by name", [1]);
    expect(rows).toEqual([{ name: "apple" }, { name: "cherry" }]);
    expect(await db.execute("update t_db_items set active = $1", [false])).toBe(2);
  });
});

describe("transactions", () => {
  test("commit keeps the writes and returns the callback's value", async () => {
    const name = await db.transaction(async (tx) => (await tx.table(Item).insert({ name: "kiwi" })).name);
    expect(name).toBe("kiwi");
    expect(await items.first({ name: "kiwi" })).not.toBeNull();
  });

  test("a throw rolls everything back", async () => {
    const before = await items.count();
    await expect(
      db.transaction(async (tx) => {
        await tx.table(Item).insert({ name: "mango" });
        await tx.execute("update t_db_items set price = 0");
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await items.count()).toBe(before);
    expect(await items.first({ name: "mango" })).toBeNull();
  });

  test("void callbacks work", async () => {
    await db.transaction(async (tx) => {
      await tx.execute("select 1");
    });
  });
});

describe("migrate", () => {
  const files = [
    { name: "t_db_002_seed", sql: "insert into t_db_migrated (label) values ('a;b'); -- trailing; comment\ninsert into t_db_migrated (label) values ($$x;y$$);" },
    { name: "t_db_001_create", sql: "create table t_db_migrated (id serial primary key, label text not null);" },
  ];

  test("applies pending files in name order, once", async () => {
    await db.execute("drop table if exists t_db_migrated");
    await db.execute("create table if not exists qala_migrations (name text primary key, applied_at timestamptz not null default now())");
    await db.execute("delete from qala_migrations where name like 't_db_%'");
    expect(await migrate(db, files)).toEqual(["t_db_001_create", "t_db_002_seed"]);
    expect(await migrate(db, files)).toEqual([]);
    expect((await db.query("select label from t_db_migrated order by id")).map((r) => r["label"])).toEqual(["a;b", "x;y"]);
  });

  test("a failing migration is rolled back and not recorded", async () => {
    await expect(migrate(db, [{ name: "t_db_003_bad", sql: "insert into t_db_migrated (label) values ('ok'); select nope_column from t_db_migrated;" }])).rejects.toBeInstanceOf(DatabaseError);
    expect((await db.query("select count(*)::int as n from t_db_migrated"))[0]?.["n"]).toBe(2);
    expect(await db.query("select name from qala_migrations where name = 't_db_003_bad'")).toEqual([]);
  });
});

describe("migration lock", () => {
  test("two concurrent migrate() calls apply each migration exactly once", async () => {
    await db.execute("drop table if exists t_db_lock");
    await db.execute("delete from qala_migrations where name like 't_db_lock_%'");
    const files = [
      { name: "t_db_lock_001", sql: "create table t_db_lock (id serial primary key, n int not null); select pg_sleep(0.2);" },
      { name: "t_db_lock_002", sql: "insert into t_db_lock (n) values (1); select pg_sleep(0.1);" },
      { name: "t_db_lock_003", sql: "insert into t_db_lock (n) values (2);" },
    ];
    const a = new Database(URL, { max: 2 });
    const b = new Database(URL, { max: 2 });
    try {
      const [ra, rb] = await Promise.all([migrate(a, files), migrate(b, files)]);
      expect([...ra, ...rb].sort()).toEqual(["t_db_lock_001", "t_db_lock_002", "t_db_lock_003"]);
      expect(ra.length === 0 || rb.length === 0).toBe(true);
      expect((await db.query("select n from t_db_lock order by id")).map((r) => r["n"])).toEqual([1, 2]);
      // released afterwards
      const free = await db.session(async (s) => {
        const got = (await s.query(`select pg_try_advisory_lock(${MIGRATION_LOCK_KEY}) as ok`))[0]?.["ok"];
        if (got === true) await s.execute(`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
        return got;
      });
      expect(free).toBe(true);
    } finally {
      a.close();
      b.close();
      await db.execute("drop table if exists t_db_lock");
      await db.execute("delete from qala_migrations where name like 't_db_lock_%'");
    }
  });

  test("the lock is held while migrating and released when a migration fails", async () => {
    await db.execute("delete from qala_migrations where name like 't_db_lock_%'");
    const other = new Database(URL, { max: 1 });
    try {
      const running = migrate(other, [{ name: "t_db_lock_slow", sql: "select pg_sleep(0.3); select nope from nowhere_t_db;" }]);
      await new Promise((r) => setTimeout(r, 100));
      const busy = await db.session(async (s) => (await s.query(`select pg_try_advisory_lock(${MIGRATION_LOCK_KEY}) as ok`))[0]?.["ok"]);
      expect(busy).toBe(false);
      await expect(running).rejects.toBeInstanceOf(DatabaseError);
      const free = await db.session(async (s) => {
        const got = (await s.query(`select pg_try_advisory_lock(${MIGRATION_LOCK_KEY}) as ok`))[0]?.["ok"];
        if (got === true) await s.execute(`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
        return got;
      });
      expect(free).toBe(true);
    } finally {
      other.close();
    }
  });

  test("lockTimeout applies to each migration's transaction", async () => {
    await db.execute("delete from qala_migrations where name like 't_db_lock_%'");
    await db.execute("drop table if exists t_db_lock_held");
    await db.execute("create table t_db_lock_held (id int)");
    try {
      await db.session(async (s) => {
        await s.transaction(async (tx) => {
          await tx.execute("lock table t_db_lock_held in access exclusive mode");
          const started = Date.now();
          const waiter = new Database(URL, { max: 1 });
          await expect(migrate(waiter, [{ name: "t_db_lock_wait", sql: "alter table t_db_lock_held add column x int;" }], { lockTimeout: "100ms" })).rejects.toThrow(/lock timeout/);
          waiter.close();
          expect(Date.now() - started).toBeLessThan(3000);
          return 0;
        });
        return 0;
      });
    } finally {
      await db.execute("drop table if exists t_db_lock_held");
    }
  });
});

describe("rollback", () => {
  const files = [
    { name: "t_db_rb_001", sql: "create table t_db_rb (id int primary key);\n-- migrate:down\ndrop table t_db_rb;" },
    { name: "t_db_rb_002", sql: "-- migrate:up\nalter table t_db_rb add column note text;\n\n-- migrate:down\nalter table t_db_rb drop column note;\n" },
    { name: "t_db_rb_003", sql: "insert into t_db_rb (id) values (1);\n-- migrate:down\n-- nothing written yet\n" },
  ];

  beforeAll(async () => {
    await db.execute("drop table if exists t_db_rb");
    await db.execute("create table if not exists qala_migrations (name text primary key, applied_at timestamptz not null default now())");
    // rollback reverts the most recent rows of the whole table: start from only this file's migrations
    await db.execute("delete from qala_migrations where name like 't_db_%'");
  });

  afterAll(async () => {
    await db.execute("drop table if exists t_db_rb");
    await db.execute("delete from qala_migrations where name like 't_db_rb_%'");
  });

  test("parseMigration splits at -- migrate:down", () => {
    expect(parseMigration("a;\n-- migrate:down\nb;")).toEqual({ up: "a;", down: "b;", hasDown: true });
    expect(parseMigration("a;").hasDown).toBe(false);
    expect(parseMigration("a;\n-- migrate:down\n-- todo\n").hasDown).toBe(false);
    expect(splitStatements(parseMigration(files[1]!.sql).up)).toEqual(["alter table t_db_rb add column note text"]);
  });

  test("refuses a migration without down SQL and reverts nothing", async () => {
    const mine = files.slice(0, 3);
    expect(await migrate(db, mine)).toEqual(["t_db_rb_001", "t_db_rb_002", "t_db_rb_003"]);
    await expect(rollback(db, mine, 2)).rejects.toThrow('Cannot roll back t_db_rb_003: it has no "-- migrate:down" section');
    expect((await migrationStatus(db, mine)).filter((s) => s.applied).length).toBe(3);
  });

  test("reverts the last N in reverse order and migrate re-applies them", async () => {
    const mine = files.slice(0, 2).concat([{ name: "t_db_rb_003", sql: "insert into t_db_rb (id) values (1);\n-- migrate:down\ndelete from t_db_rb where id = 1;" }]);
    expect(await rollback(db, mine)).toEqual(["t_db_rb_003"]);
    expect(await rollback(db, mine, 2)).toEqual(["t_db_rb_002", "t_db_rb_001"]);
    expect(await db.query("select to_regclass('t_db_rb')::text as t")).toEqual([{ t: null }]);
    const status = await migrationStatus(db, mine);
    expect(status.map((s) => [s.name, s.applied])).toEqual([
      ["t_db_rb_001", false],
      ["t_db_rb_002", false],
      ["t_db_rb_003", false],
    ]);
    expect(await migrate(db, mine)).toEqual(["t_db_rb_001", "t_db_rb_002", "t_db_rb_003"]);
    expect(await db.query("select id, note from t_db_rb")).toEqual([{ id: 1, note: null }]);
  });

  test("refuses when the file of an applied migration is missing; status reports it", async () => {
    await expect(rollback(db, files.slice(0, 2), 1)).rejects.toThrow("Cannot roll back t_db_rb_003: its migration file is missing");
    const status = await migrationStatus(db, files.slice(0, 2));
    expect(status.find((s) => s.name === "t_db_rb_003")).toMatchObject({ applied: true, missing: true });
  });

  test("a failing down is rolled back and keeps its row", async () => {
    const broken = files.slice(0, 2).concat([{ name: "t_db_rb_003", sql: "select 1;\n-- migrate:down\ndelete from t_db_rb; select nope from t_db_rb;" }]);
    await expect(rollback(db, broken)).rejects.toBeInstanceOf(DatabaseError);
    expect((await db.query("select count(*)::int as n from t_db_rb"))[0]?.["n"]).toBe(1);
    expect(await db.query("select name from qala_migrations where name = 't_db_rb_003'")).toEqual([{ name: "t_db_rb_003" }]);
  });
});

describe("helpers", () => {
  test("splitStatements respects quotes, dollar quotes and comments", () => {
    expect(splitStatements("a 'x;y'; b $f$ c; d $f$; /* ; */ e -- ;\n")).toEqual(["a 'x;y'", "b $f$ c; d $f$", "e"]);
  });

  test("toIso normalises Postgres timestamps", () => {
    expect(toIso("2026-11-15 08:00:00.123+00")).toBe("2026-11-15T08:00:00.123Z");
    expect(toIso("2026-11-15 12:00:00+04")).toBe("2026-11-15T08:00:00.000Z");
  });
});
