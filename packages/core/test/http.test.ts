import { describe, expect, test } from "bun:test";
import {
  action,
  controller,
  cors,
  createApp,
  created,
  del,
  DomainError,
  get,
  type Middleware,
  noContent,
  NotFoundError,
  post,
  RequestData,
  singleton,
  t,
  UnauthorizedError,
} from "@qala/core";

class Notes {
  private items = new Map<string, { id: string; text: string }>();
  private seq = 0;
  list() {
    return [...this.items.values()];
  }
  find(id: string) {
    const n = this.items.get(id);
    if (n === undefined) throw new NotFoundError("Note not found");
    return n;
  }
  add(text: string) {
    const n = { id: String(++this.seq), text };
    this.items.set(n.id, n);
    return n;
  }
  remove(id: string) {
    this.find(id);
    this.items.delete(id);
  }
}

const auth: Middleware = async (ctx, next) => {
  if (ctx.bearer() !== "secret") throw new UnauthorizedError();
  ctx.set("user", "ali");
  return next();
};

const NotesController = controller({ notes: Notes }, ({ notes }) => ({
  index: action({ query: { q: t.optional(t.string()), limit: t.optional(t.integer({ min: 1 })) } }, ({ query }) =>
    notes
      .list()
      .filter((n) => query.q === undefined || n.text.includes(query.q))
      .slice(0, query.limit ?? 100),
  ),
  show: action({ params: { id: t.string() } }, ({ params }) => notes.find(params.id)),
  store: action({ body: t.object({ text: t.string({ min: 1 }), tags: t.optional(t.array(t.string())) }) }, ({ body }) => created(notes.add(body.text))),
  destroy: action({ params: { id: t.string() } }, ({ params }) => {
    notes.remove(params.id);
    return noContent();
  }),
  rule: post("/:id/rule", {}, () => {
    throw new DomainError("Archived notes cannot change", "note_archived");
  }),
  crash: get("/crash", {}, () => {
    throw new Error("boom");
  }),
}));

const AdminController = controller({}, () => ({
  whoami: get("/whoami", {}, ({ ctx }) => ({ user: ctx.get("user") as string })),
  purge: del("/purge", {}, () => noContent()),
}), { middleware: [auth] });

function makeApp() {
  return createApp({
    controllers: [
      { name: "notes", prefix: "/notes", controller: NotesController },
      { name: "admin", prefix: "/admin", controller: AdminController },
    ],
    providers: [singleton(Notes, () => new Notes())],
    middleware: [cors({ origins: ["http://app.test"] })],
  });
}

async function call(app: ReturnType<typeof makeApp>, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  const reply = await app.handle(new RequestData(method, url, h, body === undefined ? "" : JSON.stringify(body), "127.0.0.1"));
  return { status: reply.status, headers: reply.headers, json: reply.body === "" ? null : (JSON.parse(reply.body) as unknown) };
}

describe("routing", () => {
  test("conventional resource routes", async () => {
    const app = makeApp();
    expect((await call(app, "POST", "/notes", { text: "salam" })).status).toBe(201);
    expect((await call(app, "GET", "/notes")).json).toEqual([{ id: "1", text: "salam" }]);
    expect((await call(app, "GET", "/notes/1")).json).toEqual({ id: "1", text: "salam" });
    expect((await call(app, "DELETE", "/notes/1")).status).toBe(204);
    expect((await call(app, "GET", "/notes/1")).status).toBe(404);
  });

  test("manifest lists every route", () => {
    expect(makeApp().manifest()).toEqual({
      notes: {
        index: ["GET", "/notes"],
        show: ["GET", "/notes/:id"],
        store: ["POST", "/notes"],
        destroy: ["DELETE", "/notes/:id"],
        rule: ["POST", "/notes/:id/rule"],
        crash: ["GET", "/notes/crash"],
      },
      admin: { whoami: ["GET", "/admin/whoami"], purge: ["DELETE", "/admin/purge"] },
    });
  });

  test("static segments win over params", async () => {
    const app = makeApp();
    expect((await call(app, "GET", "/notes/crash")).status).toBe(500);
  });

  test("404 and 405", async () => {
    const app = makeApp();
    expect((await call(app, "GET", "/missing")).json).toMatchObject({ error: { status: 404, code: "not_found" } });
    const r = await call(app, "PUT", "/notes");
    expect(r.status).toBe(405);
    expect(r.headers["allow"]).toBe("GET, POST");
  });

  test("conventional action with an unknown name fails at boot", () => {
    const Bad = controller({}, () => ({ archive: action({}, () => 1) }));
    expect(() => createApp({ controllers: [{ name: "bad", prefix: "/bad", controller: Bad }] })).toThrow(/only for index\/show\/store\/update\/destroy/);
  });
});

describe("validation", () => {
  test("body issues are all reported with 422", async () => {
    const r = await call(makeApp(), "POST", "/notes", { text: "", tags: [1] });
    expect(r.status).toBe(422);
    expect(r.json).toEqual({
      error: {
        status: 422,
        code: "validation_failed",
        message: "Invalid body",
        details: [
          { path: "text", message: "must be at least 1 characters" },
          { path: "tags[0]", message: "expected string, got number" },
        ],
      },
    });
  });

  test("query values are coerced", async () => {
    const app = makeApp();
    await call(app, "POST", "/notes", { text: "a" });
    await call(app, "POST", "/notes", { text: "b" });
    expect((await call(app, "GET", "/notes?limit=1")).json).toEqual([{ id: "1", text: "a" }]);
    expect((await call(app, "GET", "/notes?limit=0")).status).toBe(422);
    expect((await call(app, "GET", "/notes?limit=x")).status).toBe(422);
  });

  test("invalid JSON is 400, wrong content type is 415", async () => {
    const app = makeApp();
    const bad = await app.handle(new RequestData("POST", "/notes", { "content-type": "application/json" }, "{nope", ""));
    expect(bad.status).toBe(400);
    const form = await app.handle(new RequestData("POST", "/notes", { "content-type": "text/plain" }, "x", ""));
    expect(form.status).toBe(415);
  });
});

describe("errors and middleware", () => {
  test("domain errors are 422, unknown errors 500 without details", async () => {
    const app = makeApp();
    expect((await call(app, "POST", "/notes/1/rule")).json).toEqual({ error: { status: 422, code: "note_archived", message: "Archived notes cannot change", details: null } });
    expect((await call(app, "GET", "/notes/crash")).json).toEqual({ error: { status: 500, code: "internal_error", message: "Internal server error", details: null } });
  });

  test("custom error handler runs first", async () => {
    const app = createApp({
      controllers: [{ name: "notes", prefix: "/notes", controller: NotesController }],
      providers: [singleton(Notes, () => new Notes())],
      onError: (error) => (error instanceof NotFoundError ? undefined : undefined),
    });
    expect((await call(app, "GET", "/notes/9")).status).toBe(404);
  });

  test("controller middleware guards its routes", async () => {
    const app = makeApp();
    expect((await call(app, "GET", "/admin/whoami")).status).toBe(401);
    expect((await call(app, "GET", "/admin/whoami", undefined, { authorization: "Bearer secret" })).json).toEqual({ user: "ali" });
  });

  test("cors preflight and allowed origin", async () => {
    const app = makeApp();
    const pre = await call(app, "OPTIONS", "/notes", undefined, { origin: "http://app.test" });
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("http://app.test");
    const other = await call(app, "GET", "/notes", undefined, { origin: "http://evil.test" });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("container", () => {
  test("singletons are shared, missing providers explain themselves", () => {
    class A {}
    class B {
      constructor(readonly a: A) {}
    }
    const app = createApp({ controllers: [], providers: [singleton(A, () => new A()), singleton(B, (c) => new B(c.get(A)))] });
    expect(app.container.get(B).a).toBe(app.container.get(A));
    class C {}
    expect(() => app.container.get(C)).toThrow(/No provider registered for C/);
  });
});

describe("t.literal", () => {
  test("accepts listed values, coerces query text, rejects others", async () => {
    const { validate } = await import("@qala/core");
    const P = t.literal([0, 1, 2, 3]);
    expect(validate(P, 2)).toEqual({ ok: true, value: 2 });
    expect(validate(P, "3", true)).toEqual({ ok: true, value: 3 });
    expect(validate(P, 9)).toEqual({ ok: false, issues: [{ path: "", message: "must be one of: 0, 1, 2, 3", code: "one_of", params: { values: "0, 1, 2, 3" } }] });
    expect(validate(P, "urgent")).toMatchObject({ ok: false });
  });
});
