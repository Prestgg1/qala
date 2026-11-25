/**
 * A small app for the session/CSRF process tests (test/native.test.ts). Runs under Bun and, built with scriptc
 * (`--node-islands=off`), as a native binary.
 */
import { Context, controller, createApp, Database, get, post, serve, t, value } from "@qala/core";
import { csrf, logoutEverywhere, session, sessions, SessionStore } from "@qala/session";

class SignedIn {
  constructor(readonly id: string) {}
}

async function authenticate(ctx: Context): Promise<SignedIn | null> {
  const id = session(ctx).userId;
  return id === null ? null : new SignedIn(id);
}

const Login = t.object({ user: t.string() });

const Lab = controller({}, () => ({
  login: post("/login", { body: Login }, ({ ctx, body }) => {
    session(ctx).login(body.user);
    return { csrf: session(ctx).csrfToken() };
  }),
  me: get("/me", { auth: true }, ({ ctx }) => ({ user: session(ctx).userId ?? "", visits: session(ctx).get("visits") ?? "0" })),
  token: get("/csrf", {}, ({ ctx }) => ({ csrf: session(ctx).csrfToken() })),
  visit: post("/visit", { auth: true }, ({ ctx }) => {
    const n = Number(session(ctx).get("visits") ?? "0") + 1;
    session(ctx).set("visits", String(n));
    return { visits: n };
  }),
  logout: post("/logout", {}, ({ ctx }) => {
    session(ctx).logout();
    return { ok: true };
  }),
  everywhere: post("/logout-everywhere", { auth: true }, async ({ ctx }) => ({ ended: await logoutEverywhere(ctx, true) })),
}));

const url = process.env["DATABASE_URL"] ?? "postgres://qala:qala@localhost:5432/qala_test";
const db = new Database(url, { max: 4 });
const store = new SessionStore(db, { secure: true });

const app = createApp({
  controllers: [{ name: "lab", prefix: "", controller: Lab }],
  providers: [value(Database, db)],
  middleware: [sessions({ secure: true }, store), csrf()],
  authenticate,
});

store.install().then(() =>
  serve(app, { port: Number(process.env["PORT"] ?? "3000"), host: "127.0.0.1", handleSignals: false }).then(() => console.log("ready")),
);
