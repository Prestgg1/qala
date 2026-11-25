import { ForbiddenError, type Context, type Middleware, type Reply } from "@qala/core";
import { SESSION_KEY, Session, SessionConfig, type SessionOptions } from "./session";
import { verifyMaskedToken } from "./tokens";

export type CsrfOptions = {
  /**
   * Origins allowed to send unsafe requests, e.g. `["https://app.example.com"]`. Default: the request's own host
   * (`Host` header) over http or https.
   */
  origins?: string[];
  /** Request header carrying the token (default `x-csrf-token`). */
  header?: string;
  /** Form field carrying the token in `application/x-www-form-urlencoded` bodies (default `_csrf`). */
  field?: string;
  /** Session cookie name, when `sessions()` uses a custom one (pass the same options as to `sessions()`). */
  session?: SessionOptions;
};

/** Whether `method` changes state (everything except GET, HEAD, OPTIONS and TRACE). */
export function isUnsafeMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD" && m !== "OPTIONS" && m !== "TRACE";
}

/** The value of `name` in a urlencoded body, or "". */
export function formField(body: string, name: string): string {
  for (const pair of body.split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (decodeForm(pair.slice(0, eq)) === name) return decodeForm(pair.slice(eq + 1));
  }
  return "";
}

function decodeForm(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/**
 * Why an unsafe request fails the Origin / Sec-Fetch-Site checks, or "" when it passes. Requests without either
 * header (non-browser clients, old browsers) pass here and rely on the token.
 */
export function originProblem(ctx: Context, origins: string[]): string {
  const origin = ctx.header("origin");
  if (origin !== undefined) {
    if (origin === "null") return "opaque origin";
    if (origins.length > 0) return origins.includes(origin) ? "" : "cross-origin request";
    const host = ctx.header("host") ?? "";
    if (host !== "" && (origin === `https://${host}` || origin === `http://${host}`)) return "";
    return "cross-origin request";
  }
  const site = ctx.header("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return "cross-site request";
  return "";
}

/**
 * CSRF protection for cookie-authenticated requests. Run it after `sessions()`:
 *
 *   middleware: [sessions(), csrf()]
 *
 * For POST/PUT/PATCH/DELETE (anything but GET/HEAD/OPTIONS/TRACE):
 *  - requests with `Authorization: Bearer …` are exempt (a browser cannot attach one cross-site without CORS);
 *  - the `Origin` header, if any, must be an allowed origin; without it, `Sec-Fetch-Site` must not be `cross-site`
 *    or `same-site`; `Origin: null` is refused;
 *  - when the request carries the session cookie, it must also carry a token from `session(ctx).csrfToken()` in the
 *    `x-csrf-token` header or the `_csrf` form field, compared in constant time.
 * Failures are 403.
 */
export function csrf(options: CsrfOptions = {}): Middleware {
  const origins = options.origins ?? [];
  const header = (options.header ?? "x-csrf-token").toLowerCase();
  const field = options.field ?? "_csrf";
  const cookieName = new SessionConfig(options.session ?? {}).cookieName;
  return async (ctx: Context, next: () => Promise<Reply>): Promise<Reply> => {
    if (!isUnsafeMethod(ctx.method)) return next();
    if (ctx.bearer() !== undefined) return next();
    const problem = originProblem(ctx, origins);
    if (problem !== "") throw new ForbiddenError(`CSRF check failed: ${problem}`);
    const cookie = ctx.cookie(cookieName);
    if (cookie === undefined || cookie === "") return next();
    const value = ctx.get(SESSION_KEY);
    if (!(value instanceof Session)) throw new Error("csrf() needs sessions() to run before it");
    const current = value;
    // A stale cookie (no live session) carries no authority; let the request through as anonymous.
    if (!current.exists) return next();
    let token = ctx.header(header) ?? "";
    if (token === "") {
      const type = ctx.header("content-type") ?? "";
      if (type.startsWith("application/x-www-form-urlencoded")) token = formField(ctx.request.body, field);
    }
    if (token === "" || !verifyMaskedToken(token, current.csrfSecret())) throw new ForbiddenError("CSRF token missing or invalid");
    return next();
  };
}
