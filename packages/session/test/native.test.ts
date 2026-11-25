/**
 * End-to-end session and CSRF flow against test/fixtures/session-app.ts, under Bun and, with QALA_NATIVE=1, as a
 * scriptc native binary (`--node-islands=off`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");
const FIXTURE = join(import.meta.dir, "fixtures/session-app.ts");
const DB_URL = process.env.QALA_TEST_DATABASE_URL ?? "postgres://qala:qala@localhost:5432/qala_test";
const NATIVE = process.env["QALA_NATIVE"] === "1";

let nativeBinary = "";
let nativeDir = "";

beforeAll(() => {
  if (!NATIVE) return;
  nativeDir = mkdtempSync(join(tmpdir(), "qala-session-"));
  nativeBinary = join(nativeDir, "app");
  const scriptc = join(ROOT, "node_modules/.bin/scriptc");
  const built = spawnSync(scriptc, ["build", FIXTURE, "--node-islands=off", "-o", nativeBinary], { cwd: ROOT, encoding: "utf8" });
  if (built.status !== 0) throw new Error(`scriptc failed:\n${built.stdout}\n${built.stderr}`);
}, 300_000);

afterAll(() => {
  if (nativeDir !== "") rmSync(nativeDir, { recursive: true, force: true });
});

let nextPort = 43000 + Math.floor(Math.random() * 2000);

type Running = { proc: ChildProcess; base: string; output: () => string };

async function start(target: string): Promise<Running> {
  const port = nextPort++;
  const env = { ...process.env, PORT: String(port), DATABASE_URL: DB_URL };
  const proc = target === "native" ? spawn(nativeBinary, [], { env }) : spawn("bun", [FIXTURE], { env, cwd: ROOT });
  let out = "";
  proc.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  proc.stderr!.on("data", (d: Buffer) => (out += d.toString()));
  for (let i = 0; i < 200 && !out.includes("ready"); i++) await Bun.sleep(25);
  if (!out.includes("ready")) throw new Error(`fixture did not start:\n${out}`);
  return { proc, base: `http://127.0.0.1:${port}`, output: () => out };
}

/** The `name=value` of the session cookie a response set ("" for a clearing cookie, null when none). */
function sessionCookie(res: Response): string | null {
  for (const line of res.headers.getSetCookie()) {
    if (!line.startsWith("__Host-qala_session=")) continue;
    const pair = line.split(";")[0]!;
    return pair.endsWith("=") ? "" : pair;
  }
  return null;
}

function suite(target: string): void {
  describe(`session and CSRF flow (${target})`, () => {
    let app: Running;
    beforeAll(async () => {
      app = await start(target);
    });
    afterAll(() => {
      app.proc.kill("SIGKILL");
    });

    test("login → cookie → authenticated request → CSRF → logout", async () => {
      const b = app.base;
      // An anonymous visitor gets a session (and a cookie) only once something is stored: here a CSRF token.
      expect(sessionCookie(await fetch(`${b}/me`))).toBeNull();
      const anon = await fetch(`${b}/csrf`);
      const anonCookie = sessionCookie(anon)!;
      expect(anon.headers.getSetCookie()[0]).toMatch(/^__Host-qala_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
      const anonToken = ((await anon.json()) as { csrf: string }).csrf;

      // Logging in while carrying that cookie needs its CSRF token…
      const json = { "content-type": "application/json" };
      const refused = await fetch(`${b}/login`, { method: "POST", headers: { ...json, cookie: anonCookie }, body: JSON.stringify({ user: "alice" }) });
      expect(refused.status).toBe(403);
      // …and issues a NEW token: the pre-login cookie stops working (session fixation).
      const login = await fetch(`${b}/login`, { method: "POST", headers: { ...json, cookie: anonCookie, "x-csrf-token": anonToken }, body: JSON.stringify({ user: "alice" }) });
      expect(login.status).toBe(200);
      const cookie = sessionCookie(login)!;
      expect(cookie).not.toBe(anonCookie);
      const token = ((await login.json()) as { csrf: string }).csrf;
      expect((await fetch(`${b}/me`, { headers: { cookie: anonCookie } })).status).toBe(401);

      const me = await fetch(`${b}/me`, { headers: { cookie } });
      expect(await me.json()).toEqual({ user: "alice", visits: "0" });

      // Unsafe request without a token, with a wrong one, with a token of the old session, from another origin: 403.
      expect((await fetch(`${b}/visit`, { method: "POST", headers: { cookie } })).status).toBe(403);
      expect((await fetch(`${b}/visit`, { method: "POST", headers: { cookie, "x-csrf-token": "x".repeat(86) } })).status).toBe(403);
      expect((await fetch(`${b}/visit`, { method: "POST", headers: { cookie, "x-csrf-token": anonToken } })).status).toBe(403);
      expect((await fetch(`${b}/visit`, { method: "POST", headers: { cookie, "x-csrf-token": token, origin: "https://evil.example" } })).status).toBe(403);
      expect((await fetch(`${b}/visit`, { method: "POST", headers: { cookie, "x-csrf-token": token, "sec-fetch-site": "cross-site" } })).status).toBe(403);

      // With the token (header, or form field): accepted, and the session data persists.
      const ok = await fetch(`${b}/visit`, { method: "POST", headers: { cookie, "x-csrf-token": token, "sec-fetch-site": "same-origin" } });
      expect(await ok.json()).toEqual({ visits: 1 });
      const fresh = ((await (await fetch(`${b}/csrf`, { headers: { cookie } })).json()) as { csrf: string }).csrf;
      expect(fresh).not.toBe(token);
      const form = await fetch(`${b}/visit`, {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: b },
        body: `_csrf=${encodeURIComponent(fresh)}`,
      });
      expect(form.status).toBe(200);
      expect(await (await fetch(`${b}/me`, { headers: { cookie } })).json()).toEqual({ user: "alice", visits: "2" });

      // Logout clears the cookie and kills the session server-side.
      const out = await fetch(`${b}/logout`, { method: "POST", headers: { cookie, "x-csrf-token": token } });
      expect(out.status).toBe(200);
      expect(sessionCookie(out)).toBe("");
      expect((await fetch(`${b}/me`, { headers: { cookie } })).status).toBe(401);
      expect((await fetch(`${b}/visit`, { method: "POST", headers: { cookie, "x-csrf-token": token } })).status).toBe(401);
    }, 20_000);

    test("log out everywhere ends the user's other sessions", async () => {
      const b = app.base;
      const json = { "content-type": "application/json" };
      const user = `bob-${target}-${Date.now()}`;
      const logins = [];
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${b}/login`, { method: "POST", headers: json, body: JSON.stringify({ user }) });
        logins.push({ cookie: sessionCookie(res)!, token: ((await res.json()) as { csrf: string }).csrf });
      }
      const [keep, other1, other2] = logins as [{ cookie: string; token: string }, { cookie: string; token: string }, { cookie: string; token: string }];
      const res = await fetch(`${b}/logout-everywhere`, { method: "POST", headers: { cookie: keep.cookie, "x-csrf-token": keep.token } });
      expect(await res.json()).toEqual({ ended: 2 });
      expect((await fetch(`${b}/me`, { headers: { cookie: keep.cookie } })).status).toBe(200);
      expect((await fetch(`${b}/me`, { headers: { cookie: other1.cookie } })).status).toBe(401);
      expect((await fetch(`${b}/me`, { headers: { cookie: other2.cookie } })).status).toBe(401);
    });

    test("bearer requests and requests without the session cookie skip the token check", async () => {
      const b = app.base;
      // No session cookie: only the origin checks apply (here: none fail), then auth answers 401, not 403.
      expect((await fetch(`${b}/visit`, { method: "POST" })).status).toBe(401);
      expect((await fetch(`${b}/visit`, { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403);
      expect((await fetch(`${b}/visit`, { method: "POST", headers: { authorization: "Bearer abc", origin: "https://evil.example" } })).status).toBe(401);
    });
  });
}

suite("bun");
if (NATIVE) suite("native");
