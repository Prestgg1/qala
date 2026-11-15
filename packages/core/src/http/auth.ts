import { UnauthorizedError } from "../errors";
import type { Context } from "./context";

/**
 * Types an app plugs in. `qala generate` augments it from `app/auth.ts`:
 *
 *   declare module "@qala/core" { interface AuthTypes { user: import("../app/auth").AppUser } }
 */
// biome-ignore lint: an interface for declaration merging
export interface AuthTypes {}

/** The app's signed-in user type (`unknown` until `app/auth.ts` exists). */
export type AppUser = AuthTypes extends { user: infer U } ? U : unknown;

/**
 * Resolves the signed-in user of a request (a session cookie, a bearer token…), or null. The app exports it from
 * `app/auth.ts` as `export async function authenticate(ctx: Context): Promise<AppUser | null>`.
 */
export type Authenticate = (ctx: Context) => Promise<unknown>;

/** Key under which the authenticated user is kept on the request context. */
export const USER_KEY = "qala.user";

/** The authenticated user of this request, or null (null also when the route did not authenticate). */
export function currentUser(ctx: Context): AppUser | null {
  const user = ctx.get(USER_KEY);
  if (user === undefined || user === null) return null;
  return user as AppUser;
}

/** Like `currentUser`, but a missing user is a 401. */
export function requireUser(ctx: Context): AppUser {
  const user = ctx.get(USER_KEY);
  if (user === undefined || user === null) throw new UnauthorizedError();
  return user as AppUser;
}
