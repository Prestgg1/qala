import type { Context } from "@qala/core";
import { env } from "../.qala/env.gen";

export type AppUser = { token: string };

/** Writes need `Authorization: Bearer <API_TOKEN>`; reads are public. */
export async function authenticate(ctx: Context): Promise<AppUser | null> {
  const token = ctx.bearer();
  return token === env.API_TOKEN ? { token } : null;
}
