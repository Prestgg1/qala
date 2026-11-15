# Errors

Throw anywhere; every error becomes the same JSON:

```json
{ "error": { "status": 404, "code": "not_found", "message": "Task not found", "details": null } }
```

## Declare your errors as data

```ts
// app/domain/task.errors.ts
export const TaskErrors = errors({
  AlreadyDone: [422, "The task is already completed"],
  NotYours: [403, "Only the assignee can do this"],
});

throw TaskErrors.AlreadyDone();                     // 422, code "already_done"
throw TaskErrors.NotYours().with({ taskId });       // with details
```

The key becomes the code in snake_case. No classes to write.

Built in: `BadRequestError` 400, `UnauthorizedError` 401, `ForbiddenError` 403, `NotFoundError` 404,
`ConflictError` 409, `TooManyRequestsError` 429, `ValidationError` 422; `DomainError` maps to 422.
Anything else is a 500 with the details hidden (shown with `exposeErrors: true` in development) and logged.

## Database constraints

Constraint violations from PostgreSQL become client errors without any code:

| Postgres | status | code | details |
|---|---|---|---|
| unique violation (23505) | 409 | `unique_violation` | `{ constraint, fields: ["email"] }` |
| foreign key violation (23503) | 400 | `foreign_key_violation` | `{ constraint, fields: ["projectId"] }` |
| not null violation (23502) | 422 | `not_null_violation` | `{ field: "title" }` |
| invalid input syntax (22P02) | 400 | `invalid_input` | — |

Field names are camelCase, like your models. Map other cases yourself in `onError` (`app/kernel.ts`), which runs first.

## Validation

Every problem is reported at once:

```json
{ "error": { "status": 422, "code": "validation_failed", "message": "Invalid body",
  "details": [{ "path": "title", "message": "is required" }, { "path": "tags[0]", "message": "expected string, got number" }] } }
```

## Languages

Framework messages (validation issues and built-in errors) follow the request's `Accept-Language`, falling back
to the app's `locale` (default `en`). English and Azerbaijani ship with Qala:

```json
{ "error": { "status": 422, "code": "validation_failed", "message": "Yanlış sorğu məlumatı",
  "details": [{ "path": "title", "message": "Bu sahəni doldurun" }] } }
```

- Set the default: `createApp({ locale: "az" })` (or `export const kernel = { locale: "az" }`).
- Add a language: `registerLocale("tr", { required: "Bu alan zorunlu", … })` — missing keys fall back to English.
- Your own texts are never translated: `t.string({ min: 3, message: "Kod qısadır" })`, `errors({ … })`, `new NotFoundError("…")`.

Catalog keys: `required`, `type`, `min_length`, `max_length`, `pattern`, `format`, `integer`, `min`, `max`, `one_of`,
`min_items`, `max_items`, and the error codes (`not_found`, `resource_not_found`, `unauthorized`, `forbidden`,
`validation_failed`, `unique_violation`, …); see `packages/core/src/i18n/messages.ts`.
