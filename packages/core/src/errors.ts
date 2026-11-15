import type { Issue } from "./schema";

/**
 * An error that becomes an HTTP response. Throw it from anywhere (controller, service, repository);
 * the global error handler turns it into `{ error: { status, code, message, details } }`.
 *
 * Errors created without an explicit message are `translatable`: their message is looked up by `code`
 * in the request's locale (with `params` filled in).
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = "http_error",
    readonly details: unknown = null,
    readonly translatable: boolean = false,
    readonly params: Record<string, string> = {},
  ) {
    super(message);
  }

  /** The same error carrying `details` (e.g. which field, which limit). */
  with(details: unknown): HttpError {
    return new HttpError(this.status, this.message, this.code, details, this.translatable, this.params);
  }
}

export class BadRequestError extends HttpError {
  constructor(message?: string, details: unknown = null) {
    super(400, message ?? "Bad request", "bad_request", details, message === undefined);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message?: string) {
    super(401, message ?? "Unauthorized", "unauthorized", null, message === undefined);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message?: string) {
    super(403, message ?? "Forbidden", "forbidden", null, message === undefined);
  }
}

export class NotFoundError extends HttpError {
  constructor(message?: string) {
    super(404, message ?? "Not found", "not_found", null, message === undefined);
  }
}

export class ConflictError extends HttpError {
  constructor(message?: string) {
    super(409, message ?? "Conflict", "conflict", null, message === undefined);
  }
}

/** Request input that failed its schema: 422 with every problem found. */
export class ValidationError extends HttpError {
  constructor(
    readonly issues: Issue[],
    where = "request",
  ) {
    super(422, `Invalid ${where}`, "validation_failed", issues, true, { where });
  }
}

export class TooManyRequestsError extends HttpError {
  constructor(message?: string) {
    super(429, message ?? "Too many requests", "too_many_requests", null, message === undefined);
  }
}

/** A domain rule was broken (e.g. completing an archived task). Maps to 422 unless handled otherwise. */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string = "domain_rule",
  ) {
    super(message);
  }
}

/** `[status, message]` of one declared error. */
export type ErrorSpec = readonly [number, string];

/** Factories for declared errors: `TaskErrors.AlreadyDone()` → an `HttpError` to throw. */
export type ErrorFactories<S> = { readonly [K in keyof S]: () => HttpError };

/** `AlreadyDone` → `already_done`. */
function snakeCode(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Declares an app's errors as data; each key becomes a factory and its snake_case name the error code:
 *
 *   export const TaskErrors = errors({
 *     AlreadyDone: [422, "The task is already completed"],
 *     NotYours: [403, "Only the assignee can do this"],
 *   });
 *   throw TaskErrors.AlreadyDone();                      // 422 { code: "already_done", ... }
 *   throw TaskErrors.NotYours().with({ taskId });        // with details
 */
export function errors<const S extends Record<string, ErrorSpec>>(specs: S): ErrorFactories<S> {
  const out: Record<string, () => HttpError> = {};
  for (const name of Object.keys(specs)) {
    const spec = specs[name]!;
    const status = spec[0];
    const message = spec[1];
    const code = snakeCode(name);
    out[name] = () => new HttpError(status, message, code);
  }
  return out as unknown as ErrorFactories<S>;
}
