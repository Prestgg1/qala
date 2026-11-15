import type { Context } from "./context";
import type { Reply } from "./reply";

/**
 * Runs around every request (global) or every action of a controller: call `next()` to continue,
 * or return a `Reply` / throw an `HttpError` to stop.
 *
 *   export const auth: Middleware = async (ctx, next) => {
 *     if (ctx.bearer() !== secret) throw new UnauthorizedError();
 *     return next();
 *   };
 */
export type Middleware = (ctx: Context, next: () => Promise<Reply>) => Promise<Reply>;

export function compose(middleware: Middleware[], ctx: Context, last: () => Promise<Reply>): Promise<Reply> {
  const run = (index: number): Promise<Reply> => {
    if (index === middleware.length) return last();
    return middleware[index]!(ctx, () => run(index + 1));
  };
  return run(0);
}
