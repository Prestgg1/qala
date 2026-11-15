import { cors, DatabaseError, json, Logger, requestLogger, securityHeaders, type ErrorHandler, type Middleware } from "@qala/core";
import { config } from "../config/app";
import { writeGuard } from "./http/middleware/write-guard";

const logger = new Logger(config.logLevel, config.logFormat);

/** Database errors the API explains instead of answering 500. */
const onError: ErrorHandler = (error) => {
  if (error instanceof DatabaseError && error.code === "23505") {
    return json({ error: { status: 409, code: "conflict", message: "A task with this title already exists", details: null } }, 409);
  }
  return undefined;
};

/** Global HTTP pipeline: middleware for every request and the app-wide error handler. */
export const kernel: { middleware?: Middleware[]; onError?: ErrorHandler; exposeErrors?: boolean } = {
  middleware: [...(config.logRequests ? [requestLogger(logger)] : []), cors(), securityHeaders(), writeGuard(config.apiToken)],
  onError,
  exposeErrors: config.logLevel === "debug",
};
