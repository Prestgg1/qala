import { cors, DatabaseError, json, Logger, requestLogger, securityHeaders, type ErrorHandler, type Middleware } from "@qala/core";
import { env } from "../.qala/env.gen";

const logger = new Logger(env.LOG_LEVEL, env.LOG_FORMAT);

/** Global HTTP pipeline; a duplicate title answers 409 "conflict" instead of the generic unique_violation. */
export const kernel: { middleware?: Middleware[]; onError?: ErrorHandler; exposeErrors?: boolean } = {
  middleware: [...(env.LOG_REQUESTS ? [requestLogger(logger)] : []), cors(), securityHeaders()],
  onError: (error) =>
    error instanceof DatabaseError && error.code === "23505"
      ? json({ error: { status: 409, code: "conflict", message: "A task with this title already exists", details: null } }, 409)
      : undefined,
  exposeErrors: env.LOG_LEVEL === "debug",
};
