import { TooManyRequestsError } from "../errors";
import type { Logger } from "../log";
import type { Middleware } from "../http/middleware";
import { Reply } from "../http/reply";

export type CorsOptions = {
  /** Allowed origins; `["*"]` allows any (default). */
  origins?: string[];
  methods?: string[];
  headers?: string[];
  credentials?: boolean;
  maxAge?: number;
};

/** CORS headers and preflight (`OPTIONS`) answers. */
export function cors(options: CorsOptions = {}): Middleware {
  const origins = options.origins ?? ["*"];
  const methods = (options.methods ?? ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).join(", ");
  const headers = (options.headers ?? ["content-type", "authorization"]).join(", ");
  const credentials = options.credentials ?? false;
  const maxAge = String(options.maxAge ?? 600);
  return async (ctx, next) => {
    const origin = ctx.header("origin");
    if (origin !== undefined) {
      const any = origins.includes("*");
      if (any || origins.includes(origin)) {
        ctx.setHeader("access-control-allow-origin", any && !credentials ? "*" : origin);
        if (!any || credentials) ctx.setHeader("vary", "origin");
        if (credentials) ctx.setHeader("access-control-allow-credentials", "true");
      }
    }
    if (ctx.method === "OPTIONS") {
      ctx.setHeader("access-control-allow-methods", methods);
      ctx.setHeader("access-control-allow-headers", headers);
      ctx.setHeader("access-control-max-age", maxAge);
      return new Reply(204, "", {});
    }
    return next();
  };
}

/** One log line per request: method, path, status and duration. */
export function requestLogger(logger: Logger): Middleware {
  return async (ctx, next) => {
    let status = 500;
    try {
      const reply = await next();
      status = reply.status;
      return reply;
    } catch (error) {
      status = error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : 500;
      throw error;
    } finally {
      logger.info(`${ctx.method} ${ctx.path}`, { status, ms: Date.now() - ctx.startedAt });
    }
  };
}

/** Common security headers. */
export function securityHeaders(): Middleware {
  return async (ctx, next) => {
    ctx.setHeader("x-content-type-options", "nosniff");
    ctx.setHeader("x-frame-options", "DENY");
    ctx.setHeader("referrer-policy", "no-referrer");
    return next();
  };
}

export type RateLimitOptions = {
  /** Requests allowed per window per key. */
  limit: number;
  windowMs: number;
  /** What identifies a client (default: its IP). */
  key?: (ip: string, authorization: string | undefined) => string;
};

/** A fixed-window, in-memory rate limit (per process). */
export function rateLimit(options: RateLimitOptions): Middleware {
  const hits = new Map<string, number>();
  let windowStart = Date.now();
  return async (ctx, next) => {
    const now = Date.now();
    if (now - windowStart >= options.windowMs) {
      hits.clear();
      windowStart = now;
    }
    const key = options.key === undefined ? ctx.request.ip : options.key(ctx.request.ip, ctx.header("authorization"));
    const count = (hits.get(key) ?? 0) + 1;
    hits.set(key, count);
    ctx.setHeader("x-ratelimit-limit", String(options.limit));
    ctx.setHeader("x-ratelimit-remaining", String(Math.max(0, options.limit - count)));
    if (count > options.limit) {
      ctx.setHeader("retry-after", String(Math.ceil((windowStart + options.windowMs - now) / 1000)));
      throw new TooManyRequestsError();
    }
    return next();
  };
}
