# Sessions and CSRF

`@qala/session` keeps sessions in PostgreSQL and protects cookie-authenticated requests against CSRF. It compiles
with scriptc like the rest of the framework (it is checked natively in CI).

```sh
bun add @qala/session
```

## 1. Add the table

Copy the migration into your app and apply it:

```sh
cp node_modules/@qala/session/migrations/0001_qala_sessions.sql database/migrations/0003_qala_sessions.sql
qala migrate
```

(Pick the next number in `database/migrations/`.) The same SQL is exported as `SESSIONS_MIGRATION`, for
`migrate(db, [{ name: "0003_qala_sessions", sql: SESSIONS_MIGRATION }])` from code. `qala migrate:make` does not know
this table and only mentions it in its "not in the models" comments, it never drops it.

| column | |
|---|---|
| `id` | SHA-256 (hex) of the cookie token — the token itself is never stored |
| `user_id` | set by `login()`, used by "log out everywhere" |
| `data` | `jsonb` of string values |
| `created_at`, `last_seen_at`, `expires_at` | absolute and idle expiry |
| `ip`, `user_agent` | of the last write, for a "your devices" page |

## 2. Middleware

```ts
// app/kernel.ts
import { sessions, csrf } from "@qala/session";

export const kernel = {
  middleware: [sessions(), csrf()],
};
```

`sessions()` uses the app's `Database`. Options (all optional):

| option | default | |
|---|---|---|
| `cookieName` | `__Host-qala_session` | `qala_session` when `secure: false` |
| `secure` | `true` | the cookie is always `HttpOnly`, `Path=/`, without `Domain` |
| `sameSite` | `"lax"` | |
| `idleTimeout` | `7200` (2 h) | seconds without a request |
| `absoluteTimeout` | `604800` (7 days) | seconds since login, whatever happens; also the cookie's `Max-Age` |
| `touchInterval` | `60` | an unchanged session updates `last_seen_at` at most this often |
| `cleanupInterval` | `3600` | expired rows are deleted in the background of a request this often (`0` = never) |

Browsers accept `Secure` cookies on `http://localhost`, so the defaults work in development. A plain-HTTP host other
than localhost needs `secure: false` (and therefore a cookie name without `__Host-`).

## 3. Authenticate from the session

```ts
// app/auth.ts
import type { Context } from "@qala/core";
import { session } from "@qala/session";
import { users } from "./infrastructure/users";

export type AppUser = { id: string; email: string; isAdmin: boolean };

export async function authenticate(ctx: Context): Promise<AppUser | null> {
  const id = session(ctx).userId;
  return id === null ? null : users.find(id);
}
```

A bearer token for API clients can sit next to it: `const token = ctx.bearer(); if (token !== undefined) return apiKeys.userFor(token);`.

## 4. Log in and out

```ts
login: post("/login", { body: Credentials }, async ({ ctx, body }) => {
  const user = await users.verify(body.email, body.password);   // verifyPassword() under the hood
  if (user === null) throw new UnauthorizedError();
  session(ctx).login(user.id);                                    // new token: fixation-safe
  return { csrf: session(ctx).csrfToken() };
}),
logout: post("/logout", {}, ({ ctx }) => {
  session(ctx).logout();                                          // row deleted, cookie cleared
}),
logoutEverywhere: post("/logout-everywhere", { auth: true }, async ({ ctx }) => ({
  ended: await logoutEverywhere(ctx),                             // other devices; pass false to include this one
})),
```

`session(ctx)` always returns a `Session` (an empty one for a visitor without a cookie):

| | |
|---|---|
| `get(key)` / `set(key, value)` / `unset(key)` / `all()` | string values (JSON-encode anything else) |
| `userId` | the logged-in user id or `null` |
| `login(userId)` | regenerate + set the user; values are kept |
| `regenerate()` | new token, old one dies immediately |
| `logout()` / `destroy()` | delete the session |
| `csrfToken()` | a token for forms and `x-csrf-token` |
| `exists`, `id`, `createdAt` | `id` is the row id (hash), safe to log |

Changes are written once, after the handler (also when it throws). Nothing is stored for a visitor until a value is
set or a CSRF token is asked for.

`SessionStore` (`sessionStore(ctx)` inside a request, or `new SessionStore(db, options)` in a script/job) has
`destroyUser(userId, exceptId?)`, `countUser(userId)` and `cleanup()`; call `cleanup()` from a scheduled job if
you turned the opportunistic cleanup off.

## CSRF

`csrf()` must come after `sessions()`. For every method except GET, HEAD, OPTIONS and TRACE:

1. **Bearer requests are exempt** (`Authorization: Bearer …`): a browser cannot attach that header cross-site
   without a CORS preflight.
2. **Origin check.** `Origin`, when present, must be allowed — by default the request's own `Host` (http or https),
   or the list in `csrf({ origins: ["https://app.example.com"] })`. `Origin: null` is refused. Without `Origin`,
   `Sec-Fetch-Site: cross-site` or `same-site` is refused.
3. **Token check**, when the request carries the session cookie: the `x-csrf-token` header or, for
   `application/x-www-form-urlencoded` bodies, the `_csrf` field must hold a token from `session(ctx).csrfToken()`.

Failures are `403 Forbidden`. Requests without the session cookie skip step 3: they carry no session authority
(a login form still passes step 2; once a visitor has a session, login needs its token too).

The token is a synchronizer token bound to the session: its secret is HMAC-SHA256 of the session token, so it changes
on `login()`/`regenerate()`. Each `csrfToken()` call masks the secret with fresh random bytes (so a compressed page does
not leak it, BREACH) and verification unmasks and compares with `timingSafeEqual`.

For a single-page app, fetch a token once (`GET /csrf` returning `session(ctx).csrfToken()`) and send it as
`x-csrf-token`; for server-rendered forms, put it in `<input type="hidden" name="_csrf">`. Multipart and JSON bodies
are not searched for the field: use the header.

## Security notes

- The cookie value is 32 bytes from `randomBytes`; the database stores `sha256(token)`, so a database leak does not
  hand out live sessions.
- Lookups are by hash, so there is nothing to time; malformed cookies are rejected before any query.
- A cookie that names no live session is cleared in the response.
- Set `absoluteTimeout` to how long a login may last at most; idle expiry ends forgotten sessions sooner.
