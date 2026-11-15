import { UnauthorizedError, type Middleware } from "@qala/core";

const READS = ["GET", "HEAD", "OPTIONS"];

/** Reads are public; every write needs `Authorization: Bearer <token>`. */
export function writeGuard(token: string): Middleware {
  return async (ctx, next) => {
    if (!READS.includes(ctx.method) && ctx.bearer() !== token) throw new UnauthorizedError("A valid API token is required for changes");
    return next();
  };
}
