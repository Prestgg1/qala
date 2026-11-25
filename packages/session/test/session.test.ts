import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { controller, createApp, Database, get, post, RequestData, t, value, type Reply } from "@qala/core";
import {
  csrf,
  formField,
  hashToken,
  isToken,
  isUnsafeMethod,
  logoutEverywhere,
  maskToken,
  newToken,
  safeEqual,
  session,
  SessionConfig,
  sessions,
  SessionStore,
  verifyMaskedToken,
} from "@qala/session";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_MIGRATION } from "../src/session";

const URL = process.env.QALA_TEST_DATABASE_URL ?? "postgres://qala:qala@localhost:5432/qala_test";
const db = new Database(URL, { max: 4 });
const store = new SessionStore(db);

beforeAll(async () => {
  await store.install();
});
afterAll(() => db.close());

describe("tokens", () => {
  test("session tokens are 32 random bytes, base64url; the database sees only the SHA-256", () => {
    const a = newToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isToken(a)).toBe(true);
    expect(newToken()).not.toBe(a);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(isToken(`${a.slice(0, 42)}=`)).toBe(false);
    expect(isToken("short")).toBe(false);
  });

  test("masked CSRF tokens differ every time and all verify; tampering fails", () => {
    const secret = new Uint8Array(32).fill(7);
    const a = maskToken(secret);
    const b = maskToken(secret);
    expect(a).not.toBe(b);
    expect(a.length).toBe(86);
    expect(verifyMaskedToken(a, secret)).toBe(true);
    expect(verifyMaskedToken(b, secret)).toBe(true);
    expect(verifyMaskedToken(a, new Uint8Array(32).fill(8))).toBe(false);
    const flipped = (a[50] === "A" ? "B" : "A") + "";
    expect(verifyMaskedToken(a.slice(0, 50) + flipped + a.slice(51), secret)).toBe(false);
    expect(verifyMaskedToken(a.slice(1), secret)).toBe(false);
    expect(verifyMaskedToken("", secret)).toBe(false);
    expect(verifyMaskedToken("!".repeat(86), secret)).toBe(false);
  });

  test("safeEqual", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  test("helpers", () => {
    expect(isUnsafeMethod("post")).toBe(true);
    expect(isUnsafeMethod("DELETE")).toBe(true);
    expect(isUnsafeMethod("GET")).toBe(false);
    expect(isUnsafeMethod("HEAD")).toBe(false);
    expect(isUnsafeMethod("OPTIONS")).toBe(false);
    expect(formField("a=1&_csrf=x%2By+z&b", "_csrf")).toBe("x+y z");
    expect(formField("a=1", "_csrf")).toBe("");
  });
});

describe("config", () => {
  test("secure __Host- cookie by default", () => {
    const c = new SessionConfig({});
    expect(c.cookieName).toBe("__Host-qala_session");
    expect(c.secure).toBe(true);
    expect(c.sameSite).toBe("lax");
    expect(new SessionConfig({ secure: false }).cookieName).toBe("qala_session");
  });
  test("refuses insecure combinations", () => {
    expect(() => new SessionConfig({ secure: false, cookieName: "__Host-x" })).toThrow();
    expect(() => new SessionConfig({ secure: false, sameSite: "none" })).toThrow();
    expect(() => new SessionConfig({ table: "x; drop table y" })).toThrow();
    expect(() => new SessionConfig({ idleTimeout: 0 })).toThrow();
  });
  test("the shipped migration file matches SESSIONS_MIGRATION", () => {
    const file = readFileSync(join(import.meta.dir, "../migrations/0001_qala_sessions.sql"), "utf8");
    expect(file.split("\n").slice(1).join("\n")).toBe(SESSIONS_MIGRATION);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

const Body = t.object({ user: t.string() });
const Lab = controller({}, () => ({
  login: post("/login", { body: Body }, ({ ctx, body }) => {
    session(ctx).login(body.user);
    return { csrf: session(ctx).csrfToken() };
  }),
  token: get("/token", {}, ({ ctx }) => ({ csrf: session(ctx).csrfToken() })),
  me: get("/me", {}, ({ ctx }) => ({ user: session(ctx).userId, data: session(ctx).all(), exists: session(ctx).exists })),
  put: post("/put", {}, ({ ctx }) => {
    session(ctx).set("k", ctx.query["v"] ?? "");
    return { ok: true };
  }),
  fail: post("/fail", {}, ({ ctx }) => {
    session(ctx).set("k", "before-error");
    throw new Error("boom");
  }),
  everywhere: post("/everywhere", {}, async ({ ctx }) => ({ n: await logoutEverywhere(ctx, false) })),
  destroy: post("/destroy", {}, ({ ctx }) => {
    session(ctx).destroy();
    return { ok: true };
  }),
}));

const app = createApp({
  controllers: [{ name: "lab", prefix: "", controller: Lab }],
  providers: [value(Database, db)],
  middleware: [sessions(), csrf({ origins: ["https://app.example"] })],
});

function req(method: string, url: string, headers: Record<string, string> = {}, body = ""): Promise<Reply> {
  return app.handle(new RequestData(method, url, { host: "api.example", ...headers }, body, "10.0.0.1"));
}
function cookieOf(reply: Reply): string {
  const line = reply.cookies.find((c) => c.startsWith("__Host-qala_session="));
  return line === undefined ? "" : line.split(";")[0]!;
}
async function login(user: string): Promise<{ cookie: string; token: string; hash: string }> {
  const reply = await req("POST", "/login", { "content-type": "application/json" }, JSON.stringify({ user }));
  expect(reply.status).toBe(200);
  const cookie = cookieOf(reply);
  return { cookie, token: (JSON.parse(reply.body) as { csrf: string }).csrf, hash: hashToken(cookie.split("=")[1]!) };
}

describe("sessions() + csrf() in an app", () => {
  test("stores only the hash, with ip and user agent; values survive requests", async () => {
    const s = await login("u-store");
    const rows = await db.query("select id, user_id, ip, data::text as data, expires_at > now() + interval '6 days' as long from qala_sessions where id = $1", [s.hash]);
    expect(rows[0]).toEqual({ id: s.hash, user_id: "u-store", ip: "10.0.0.1", data: "{}", long: true });
    expect((await db.query("select 1 from qala_sessions where id = $1", [s.cookie.split("=")[1]!])).length).toBe(0);
    const put = await req("POST", "/put?v=hello", { cookie: s.cookie, "x-csrf-token": s.token, "user-agent": "UA/1" });
    expect(put.status).toBe(200);
    expect(cookieOf(put)).toBe("");
    const me = await req("GET", "/me", { cookie: s.cookie });
    expect(JSON.parse(me.body)).toEqual({ user: "u-store", data: { k: "hello" }, exists: true });
    expect((await db.query("select user_agent from qala_sessions where id = $1", [s.hash]))[0]).toEqual({ user_agent: "UA/1" });
  });

  test("a change made before the handler throws is still saved", async () => {
    const s = await login("u-throw");
    expect((await req("POST", "/fail", { cookie: s.cookie, "x-csrf-token": s.token })).status).toBe(500);
    expect(JSON.parse((await req("GET", "/me", { cookie: s.cookie })).body).data).toEqual({ k: "before-error" });
  });

  test("idle and absolute expiry", async () => {
    const idle = await login("u-idle");
    await db.execute("update qala_sessions set last_seen_at = now() - interval '3 hours' where id = $1", [idle.hash]);
    const r1 = await req("GET", "/me", { cookie: idle.cookie });
    expect(JSON.parse(r1.body).user).toBeNull();
    expect(r1.cookies.some((c) => c.startsWith("__Host-qala_session=;") && c.includes("Max-Age=0"))).toBe(true);
    const old = await login("u-abs");
    await db.execute("update qala_sessions set expires_at = now() - interval '1 second' where id = $1", [old.hash]);
    expect(JSON.parse((await req("GET", "/me", { cookie: old.cookie })).body).user).toBeNull();
    expect(await store.cleanup()).toBeGreaterThanOrEqual(2);
    expect((await db.query("select 1 from qala_sessions where id = any(string_to_array($1, ','))", [`${idle.hash},${old.hash}`])).length).toBe(0);
  });

  test("last_seen_at is touched only after touchInterval", async () => {
    const s = await login("u-touch");
    await db.execute("update qala_sessions set last_seen_at = now() - interval '10 seconds' where id = $1", [s.hash]);
    await req("GET", "/me", { cookie: s.cookie });
    const a = await db.query("select extract(epoch from now() - last_seen_at)::float8 as age from qala_sessions where id = $1", [s.hash]);
    expect(Number(a[0]!["age"])).toBeGreaterThan(5);
    await db.execute("update qala_sessions set last_seen_at = now() - interval '5 minutes' where id = $1", [s.hash]);
    await req("GET", "/me", { cookie: s.cookie });
    const b = await db.query("select extract(epoch from now() - last_seen_at)::float8 as age from qala_sessions where id = $1", [s.hash]);
    expect(Number(b[0]!["age"])).toBeLessThan(5);
  });

  test("anonymous requests store nothing; garbage cookies are ignored and cleared", async () => {
    const before = await db.query("select count(*)::int as n from qala_sessions");
    const r = await req("GET", "/me");
    expect(r.cookies).toEqual([]);
    const junk = await req("GET", "/me", { cookie: "__Host-qala_session=' or 1=1 --" });
    expect(JSON.parse(junk.body).exists).toBe(false);
    expect(junk.cookies[0]).toStartWith("__Host-qala_session=;");
    expect(await db.query("select count(*)::int as n from qala_sessions")).toEqual(before);
  });

  test("CSRF: origin allow-list, Sec-Fetch-Site, Origin null, token sources", async () => {
    const s = await login("u-csrf");
    const h = { cookie: s.cookie, "x-csrf-token": s.token };
    expect((await req("POST", "/put", { ...h, origin: "https://app.example" })).status).toBe(200);
    // With an explicit list, the request's own host is not implied.
    expect((await req("POST", "/put", { ...h, origin: "https://api.example" })).status).toBe(403);
    expect((await req("POST", "/put", { ...h, origin: "null" })).status).toBe(403);
    expect((await req("POST", "/put", { ...h, "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await req("POST", "/put", { ...h, "sec-fetch-site": "none" })).status).toBe(200);
    expect((await req("DELETE", "/put", { cookie: s.cookie })).status).toBe(403);
    // Safe methods never need a token, whatever the origin.
    expect((await req("GET", "/me", { cookie: s.cookie, origin: "https://evil.example" })).status).toBe(200);
    // A multipart/JSON body is not searched for the field: use the header.
    expect((await req("POST", "/put", { cookie: s.cookie, "content-type": "application/json" }, JSON.stringify({ _csrf: s.token }))).status).toBe(403);
    expect((await req("POST", "/put", { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded" }, `_csrf=${encodeURIComponent(s.token)}`)).status).toBe(200);
    // Bearer requests are exempt.
    expect((await req("POST", "/put", { cookie: s.cookie, authorization: "Bearer t", origin: "https://evil.example" })).status).toBe(200);
  });

  test("a CSRF token from another session is refused", async () => {
    const a = await login("u-a");
    const b = await login("u-b");
    expect((await req("POST", "/put", { cookie: a.cookie, "x-csrf-token": b.token })).status).toBe(403);
  });

  test("log out everywhere, current one included; destroy", async () => {
    const one = await login("u-all");
    const two = await login("u-all");
    expect(await store.countUser("u-all")).toBe(2);
    const r = await req("POST", "/everywhere", { cookie: one.cookie, "x-csrf-token": one.token });
    expect(JSON.parse(r.body)).toEqual({ n: 2 });
    expect(r.cookies[0]).toStartWith("__Host-qala_session=;");
    expect(await store.countUser("u-all")).toBe(0);
    expect(JSON.parse((await req("GET", "/me", { cookie: two.cookie })).body).user).toBeNull();
    const three = await login("u-d");
    await req("POST", "/destroy", { cookie: three.cookie, "x-csrf-token": three.token });
    expect(await store.countUser("u-d")).toBe(0);
  });

  test("login rotates the token and keeps values; the old token is dead", async () => {
    const first = await req("GET", "/token");
    const anon = cookieOf(first);
    const anonToken = (JSON.parse(first.body) as { csrf: string }).csrf;
    expect((await req("POST", "/put?v=cart", { cookie: anon, "x-csrf-token": anonToken })).status).toBe(200);
    const json = { cookie: anon, "content-type": "application/json" };
    // The anonymous session has a cookie, so login needs its token too.
    expect((await req("POST", "/login", json, JSON.stringify({ user: "u-rot" }))).status).toBe(403);
    const reply = await req("POST", "/login", { ...json, "x-csrf-token": anonToken }, JSON.stringify({ user: "u-rot" }));
    const fresh = cookieOf(reply);
    expect(fresh).not.toBe("");
    expect(fresh).not.toBe(anon);
    expect(JSON.parse((await req("GET", "/me", { cookie: fresh })).body)).toEqual({ user: "u-rot", data: { k: "cart" }, exists: true });
    expect(JSON.parse((await req("GET", "/me", { cookie: anon })).body).exists).toBe(false);
    expect((await db.query("select 1 from qala_sessions where id = $1", [hashToken(anon.split("=")[1]!)])).length).toBe(0);
  });
});
