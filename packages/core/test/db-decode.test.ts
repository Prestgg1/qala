import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database, model, pgIso, t, type InferModel } from "@qala/core";

const URL = process.env.QALA_TEST_DATABASE_URL ?? "postgres://qala:qala@localhost:5432/qala_test";

const shape = {
  id: t.integer(),
  title: t.string(),
  note: t.nullable(t.string()),
  done: t.boolean(),
  score: t.number(),
  dueAt: t.nullable(t.datetime()),
  createdAt: t.datetime(),
};
/** Decoded by the generic, kind-driven decoder. */
const Generic = model("t_db_order", shape);
/** Decoded by a typed decoder, written exactly as `qala generate` emits it. */
const Typed = model("t_db_order", shape);
type Row = InferModel<typeof Typed>;
Typed.useDecoder(
  (v: (string | null)[]): Row => ({
    id: Number(v[0]),
    title: v[1] ?? "",
    note: v[2] ?? null,
    done: v[3] === "t",
    score: Number(v[4]),
    dueAt: v[5] === null || v[5] === undefined ? null : pgIso(v[5]),
    createdAt: pgIso(v[6] ?? ""),
  }),
);

const db = new Database(URL, { max: 2 });

beforeAll(async () => {
  await db.execute("drop table if exists t_db_order");
  // Columns deliberately in a different order than the model: decoding must follow the model.
  await db.execute(
    "create table t_db_order (created_at timestamptz not null default now(), due_at timestamptz, score double precision not null default 0, done boolean not null default false, note text, title text not null, id serial primary key)",
  );
});

afterAll(async () => {
  await db.execute("drop table if exists t_db_order");
  db.close();
});

describe("row decoding", () => {
  test("columns are selected in model order, whatever the table order", async () => {
    const row = await db.table(Generic).insert({ title: "a", note: null, score: 2.5, dueAt: "1965-03-01T10:20:30.400Z" });
    expect(Object.keys(row)).toEqual(["id", "title", "note", "done", "score", "dueAt", "createdAt"]);
    expect(row).toMatchObject({ title: "a", note: null, done: false, score: 2.5, dueAt: "1965-03-01T10:20:30.400Z" });
  });

  test("typed decoder and generic decoder produce identical rows", async () => {
    await db.table(Typed).insert({ title: "b", note: "x", done: true, score: 1, dueAt: null });
    await db.table(Generic).insert({ title: "c", dueAt: "2030-12-31T23:59:59.999Z" });
    const generic = await db.table(Generic).all({ orderBy: ["id", "asc"] });
    const typed = await db.table(Typed).all({ orderBy: ["id", "asc"] });
    expect(typed.length).toBe(3);
    expect(typed).toEqual(generic);
    expect(JSON.stringify(typed)).toBe(JSON.stringify(generic));
    const one = await db.table(Typed).find(typed[1]!.id);
    expect(one).toEqual(generic[1]!);
    const changed = await db.table(Typed).update(typed[1]!.id, { done: false });
    expect(changed?.done).toBe(false);
  });

  test("Postgres timestamps round-trip through pgIso exactly like Date", async () => {
    const rows = await db.query(
      "select (timestamptz '2026-11-15 08:00:00+00')::text a, (timestamptz '2026-11-15 08:00:00.5+00')::text b, (timestamptz '1901-01-02 03:04:05.123456+00')::text c, now()::text d",
    );
    const r = rows[0]!;
    for (const key of ["a", "b", "c", "d"]) {
      const text = String(r[key]);
      expect(text.endsWith("+00")).toBe(true);
      expect(pgIso(text)).toBe(new Date(text.replace(" ", "T").replace(/\+00$/, "Z")).toISOString());
    }
  });
});

describe("pgIso", () => {
  const cases: [string, string][] = [
    ["2026-11-15 08:00:00+00", "2026-11-15T08:00:00.000Z"],
    ["2026-11-15 08:00:00.1+00", "2026-11-15T08:00:00.100Z"],
    ["2026-11-15 08:00:00.12+00", "2026-11-15T08:00:00.120Z"],
    ["2026-11-15 08:00:00.123+00", "2026-11-15T08:00:00.123Z"],
    ["2026-11-15 08:00:00.1234+00", "2026-11-15T08:00:00.123Z"],
    ["2026-11-15 08:00:00.12345+00", "2026-11-15T08:00:00.123Z"],
    ["2026-11-15 08:00:00.123999+00", "2026-11-15T08:00:00.123Z"],
    ["1969-12-31 23:59:59.999+00", "1969-12-31T23:59:59.999Z"],
    ["1901-01-02 03:04:05.000006+00", "1901-01-02T03:04:05.000Z"],
    ["0099-06-30 12:00:00+00", "0099-06-30T12:00:00.000Z"],
  ];
  for (const [input, expected] of cases) {
    test(input, () => {
      expect(pgIso(input)).toBe(expected);
      if (!input.startsWith("0099")) expect(pgIso(input)).toBe(new Date(input.replace(" ", "T").replace(/\+00$/, "Z")).toISOString());
    });
  }

  test("other offsets and formats fall back to Date", () => {
    expect(pgIso("2026-11-15 12:00:00+04")).toBe("2026-11-15T08:00:00.000Z");
    expect(pgIso("2026-11-15 12:00:00.25+04:30")).toBe("2026-11-15T07:30:00.250Z");
    expect(pgIso("2026-11-15")).toBe("2026-11-15T00:00:00.000Z");
  });
});
