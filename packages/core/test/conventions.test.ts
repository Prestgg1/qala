import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  action,
  authorize,
  controller,
  createApp,
  created,
  Database,
  del,
  errors,
  ForbiddenError,
  get,
  json,
  Policy,
  post,
  registerLocale,
  RequestData,
  pickLocale,
  type ResultOf,
  t,
} from "@qala/core";

type User = { id: string; role: string };
// What `qala generate` writes for an app with app/auth.ts (here by hand).
declare module "@qala/core" {
  interface AuthTypes {
    user: User;
  }
}
type Note = { id: string; ownerId: string; text: string };

const notes = new Map<string, Note>([["1", { id: "1", ownerId: "u1", text: "salam" }]]);

class NotePolicy extends Policy {
  override update(user: User, note: Note): boolean {
    return note.ownerId === user.id;
  }
  override destroy(user: User): boolean {
    return user.role === "admin";
  }
}

const NoteErrors = errors({
  AlreadyArchived: [422, "The note is already archived"],
  NotYours: [403, "Only the owner can do this"],
});

const NotesController = controller({}, () => ({
  index: action({}, () => [...notes.values()]),
  show: action({}, ({ id }) => notes.get(id) ?? null),
  store: action({ body: t.object({ text: t.string({ min: 1 }) }), auth: true }, ({ body, user }) => {
    const note = { id: String(notes.size + 1), ownerId: user.id, text: body.text };
    notes.set(note.id, note);
    return note;
  }),
  update: action({ body: t.object({ text: t.string() }), auth: true }, async ({ id, body, user }) => {
    const note = notes.get(id);
    if (note === undefined) return null;
    await authorize(new NotePolicy(), "update", user, note);
    note.text = body.text;
    return note;
  }),
  destroy: action({ auth: true }, async ({ id, user }) => {
    await authorize(new NotePolicy(), "destroy", user);
    notes.delete(id);
  }),
  whoami: get("/me", { auth: "optional" }, ({ user }) => ({ user })),
  archive: post("/:id/archive", {}, () => {
    throw NoteErrors.AlreadyArchived().with({ hint: "unarchive first" });
  }),
  explicit: post("/explicit", {}, () => json({ ok: true }, 200)),
  made: post("/made", {}, () => created({ ok: true })),
  gone: del("/gone/:id", {}, () => undefined),
}));
NotesController.resourceName = "Note";

const PrivateController = controller({}, () => ({ index: action({}, () => ({ secret: 1 })) }), { auth: true });

const users: Record<string, User> = { "t-u1": { id: "u1", role: "member" }, "t-admin": { id: "a1", role: "admin" } };

function makeApp(locale = "en") {
  return createApp({
    controllers: [
      { name: "notes", prefix: "/notes", controller: NotesController },
      { name: "private", prefix: "/private", controller: PrivateController },
    ],
    authenticate: async (ctx) => users[ctx.bearer() ?? ""] ?? null,
    locale,
  });
}

async function call(app: ReturnType<typeof makeApp>, method: string, url: string, opts: { body?: unknown; token?: string; lang?: string } = {}) {
  const h: Record<string, string> = {};
  if (opts.body !== undefined) h["content-type"] = "application/json";
  if (opts.token !== undefined) h["authorization"] = `Bearer ${opts.token}`;
  if (opts.lang !== undefined) h["accept-language"] = opts.lang;
  const reply = await app.handle(new RequestData(method, url, h, opts.body === undefined ? "" : JSON.stringify(opts.body), "127.0.0.1"));
  return { status: reply.status, json: reply.body === "" ? null : (JSON.parse(reply.body) as Record<string, unknown>) };
}

describe("response conventions", () => {
  test("null → 404 naming the resource, value → 200, `({ id })` input", async () => {
    const app = makeApp();
    expect((await call(app, "GET", "/notes/1")).json).toEqual({ id: "1", ownerId: "u1", text: "salam" });
    expect(await call(app, "GET", "/notes/99")).toEqual({ status: 404, json: { error: { status: 404, code: "not_found", message: "Note not found", details: null } } });
  });

  test("a conventional store returning a value is 201; undefined is 204", async () => {
    const app = makeApp();
    const r = await call(app, "POST", "/notes", { body: { text: "yeni" }, token: "t-u1" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ ownerId: "u1", text: "yeni" });
    expect((await call(app, "DELETE", "/notes/gone/5")).status).toBe(204);
  });

  test("explicit replies are kept as they are", async () => {
    const app = makeApp();
    expect((await call(app, "POST", "/notes/explicit")).status).toBe(200);
    expect((await call(app, "POST", "/notes/made")).status).toBe(201);
  });
});

describe("auth", () => {
  test("auth: true needs a user (401), passes a typed user", async () => {
    const app = makeApp();
    expect((await call(app, "POST", "/notes", { body: { text: "x" } })).status).toBe(401);
    expect((await call(app, "POST", "/notes", { body: { text: "x" }, token: "nope" })).status).toBe(401);
  });

  test("auth: optional passes null without credentials", async () => {
    const app = makeApp();
    expect((await call(app, "GET", "/notes/me")).json).toEqual({ user: null });
    expect((await call(app, "GET", "/notes/me", { token: "t-admin" })).json).toEqual({ user: { id: "a1", role: "admin" } });
  });

  test("controller-level auth guards every action", async () => {
    const app = makeApp();
    expect((await call(app, "GET", "/private")).status).toBe(401);
    expect((await call(app, "GET", "/private", { token: "t-u1" })).json).toEqual({ secret: 1 });
  });

  test("a route needing auth without an authenticate hook is a configuration error (500)", async () => {
    const app = createApp({ controllers: [{ name: "private", prefix: "/private", controller: PrivateController }] });
    expect((await call(app as ReturnType<typeof makeApp>, "GET", "/private")).status).toBe(500);
  });
});

describe("policies", () => {
  test("refusals are 403, permitted abilities run", async () => {
    const app = makeApp();
    expect((await call(app, "PATCH", "/notes/1", { body: { text: "x" }, token: "t-admin" })).status).toBe(403);
    expect((await call(app, "PATCH", "/notes/1", { body: { text: "dəyişdi" }, token: "t-u1" })).json).toMatchObject({ text: "dəyişdi" });
    expect((await call(app, "DELETE", "/notes/1", { token: "t-u1" })).status).toBe(403);
  });

  test("authorize() outside resources", async () => {
    await expect(authorize(new NotePolicy(), "destroy", { id: "u1", role: "member" })).rejects.toBeInstanceOf(ForbiddenError);
    await authorize(new NotePolicy(), "index", { id: "u1", role: "member" });
  });
});

describe("declared errors", () => {
  test("factories carry status, snake_case code, message and details", async () => {
    expect(await call(makeApp(), "POST", "/notes/1/archive")).toEqual({
      status: 422,
      json: { error: { status: 422, code: "already_archived", message: "The note is already archived", details: { hint: "unarchive first" } } },
    });
    const e = NoteErrors.NotYours();
    expect([e.status, e.code, e.message]).toEqual([403, "not_yours", "Only the owner can do this"]);
  });
});

describe("localized messages", () => {
  test("Accept-Language picks a catalog; validation issues and built-in errors are translated", async () => {
    const app = makeApp();
    const r = await call(app, "POST", "/notes", { body: { text: "" }, token: "t-u1", lang: "az-AZ,az;q=0.9" });
    expect(r).toEqual({ status: 422, json: { error: { status: 422, code: "validation_failed", message: "Yanlış sorğu məlumatı", details: [{ path: "text", message: "Ən azı 1 simvol olmalıdır" }] } } });
    expect((await call(app, "GET", "/notes/99", { lang: "az" })).json).toMatchObject({ error: { message: "Note tapılmadı" } });
    expect((await call(app, "GET", "/nope", { lang: "az" })).json).toMatchObject({ error: { code: "not_found", message: "Belə bir ünvan yoxdur" } });
    expect((await call(app, "POST", "/notes", { body: { text: "x" }, lang: "az" })).json).toMatchObject({ error: { message: "Giriş tələb olunur" } });
  });

  test("the app default locale applies without Accept-Language; unknown languages fall back", async () => {
    const app = makeApp("az");
    expect((await call(app, "POST", "/notes", { body: {}, token: "t-u1" })).json).toMatchObject({ error: { details: [{ path: "text", message: "Bu sahəni doldurun" }] } });
    expect((await call(app, "POST", "/notes", { body: {}, token: "t-u1", lang: "ja" })).json).toMatchObject({ error: { details: [{ path: "text", message: "Bu sahəni doldurun" }] } });
  });

  test("author-written messages stay; registered locales work", async () => {
    const C = controller({}, () => ({ store: action({ body: t.object({ code: t.string({ min: 3, message: "Kod qısadır" }) }) }, ({ body }) => body) }));
    registerLocale("tr", { required: "Bu alan zorunlu", validation_failed: "Geçersiz istek" });
    const app = createApp({ controllers: [{ name: "c", prefix: "/c", controller: C }] });
    const short = await app.handle(new RequestData("POST", "/c", { "content-type": "application/json", "accept-language": "tr" }, '{"code":"a"}', ""));
    expect(JSON.parse(short.body)).toMatchObject({ error: { message: "Geçersiz istek", details: [{ path: "code", message: "Kod qısadır" }] } });
    const missing = await app.handle(new RequestData("POST", "/c", { "content-type": "application/json", "accept-language": "tr" }, "{}", ""));
    expect(JSON.parse(missing.body)).toMatchObject({ error: { details: [{ path: "code", message: "Bu alan zorunlu" }] } });
    expect(pickLocale("de-DE, tr;q=0.5", "en")).toBe("tr");
  });
});

const URL = process.env.QALA_TEST_DATABASE_URL ?? "postgres://qala:qala@localhost:5432/qala_test";
const db = new Database(URL);
let dbUp = true;

describe("PostgreSQL constraint errors", () => {
  beforeAll(async () => {
    try {
      await db.execute("drop table if exists t_conv_item; drop table if exists t_conv_owner");
      await db.execute("create table t_conv_owner (id int primary key)");
      await db.execute("create table t_conv_item (id int primary key, owner_id int not null references t_conv_owner(id), email_address text unique)");
      await db.execute("insert into t_conv_owner values (1)");
      await db.execute("insert into t_conv_item values (1, 1, 'a@b.c')");
    } catch {
      dbUp = false;
    }
  });
  afterAll(async () => {
    if (dbUp) await db.execute("drop table if exists t_conv_item; drop table if exists t_conv_owner");
    db.close();
  });

  const C = controller({}, () => ({
    dup: post("/dup", {}, () => db.execute("insert into t_conv_item values (2, 1, 'a@b.c')")),
    fk: post("/fk", {}, () => db.execute("insert into t_conv_item values (3, 9, 'x@y.z')")),
    nn: post("/nn", {}, () => db.execute("insert into t_conv_item (id) values (4)")),
    bad: post("/bad", {}, () => db.query("select * from t_conv_owner where id = $1", ["not-a-number"])),
  }));
  const app = () => createApp({ controllers: [{ name: "c", prefix: "/c", controller: C }] });
  const send = async (path: string, lang = "en") => {
    const r = await app().handle(new RequestData("POST", path, { "accept-language": lang }, "", ""));
    return { status: r.status, json: JSON.parse(r.body) as Record<string, unknown> };
  };

  test("unique → 409 with the field, FK → 400, not null → 422, bad input → 400", async () => {
    if (!dbUp) return;
    expect(await send("/c/dup")).toEqual({ status: 409, json: { error: { status: 409, code: "unique_violation", message: "emailAddress already exists", details: { constraint: "t_conv_item_email_address_key", fields: ["emailAddress"] } } } });
    expect(await send("/c/fk")).toEqual({ status: 400, json: { error: { status: 400, code: "foreign_key_violation", message: "ownerId refers to a missing record", details: { constraint: "t_conv_item_owner_id_fkey", fields: ["ownerId"] } } } });
    expect(await send("/c/nn")).toEqual({ status: 422, json: { error: { status: 422, code: "not_null_violation", message: "ownerId is required", details: { field: "ownerId" } } } });
    expect(await send("/c/bad")).toEqual({ status: 400, json: { error: { status: 400, code: "invalid_input", message: "Invalid value", details: null } } });
    expect((await send("/c/dup", "az")).json).toMatchObject({ error: { message: "emailAddress artıq mövcuddur" } });
  });
});

// Type-level: a handler's `null` is a 404, so it is not part of the client's result type.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const resultExcludesNull: Equal<ResultOf<Promise<Note | null>>, Note> = true;
void resultExcludesNull;
