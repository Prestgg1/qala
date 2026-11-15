import type { Issue } from "./schema";

/**
 * An error that becomes an HTTP response. Throw it from anywhere (controller, service, repository);
 * the global error handler turns it into `{ error: { status, code, message, details } }`.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = "http_error",
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

export class BadRequestError extends HttpError {
  constructor(message = "Bad request", details: unknown = null) {
    super(400, message, "bad_request", details);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = "Unauthorized") {
    super(401, message, "unauthorized");
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = "Forbidden") {
    super(403, message, "forbidden");
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Not found") {
    super(404, message, "not_found");
  }
}

export class ConflictError extends HttpError {
  constructor(message = "Conflict") {
    super(409, message, "conflict");
  }
}

/** Request input that failed its schema: 422 with every problem found. */
export class ValidationError extends HttpError {
  constructor(readonly issues: Issue[], where = "request") {
    super(422, `Invalid ${where}`, "validation_failed", issues);
  }
}

export class TooManyRequestsError extends HttpError {
  constructor(message = "Too many requests") {
    super(429, message, "too_many_requests");
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
