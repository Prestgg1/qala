---
title: Observability
---

# Observability

Request ids, structured logs and health/readiness probes are built in and work the same in the native binary and
under Bun.

## Request ids

Every request gets an id. A valid incoming `x-request-id` header (1–128 characters of `A-Z a-z 0-9 . _ : @ / + = -`)
is reused, so an id set by your load balancer or an upstream service follows the request; anything else is replaced
by a generated 32-character hex id. The id is:

- on the context as `ctx.requestId`,
- added to every line of `ctx.log` (see below), the `requestLogger` line and the "Unhandled error" line,
- echoed as the `x-request-id` response header, also on 404s, errors and probes.

```ts
export const kernel = {
  requestId: false, // turn request ids off (on by default)
};
```

`validRequestId(value)` is exported if you forward ids yourself.

## Structured logs

`Logger` writes `pretty` lines for development and, with `new Logger(level, "json")`, one JSON object per line:

```ts
// app/kernel.ts
import { Logger, requestLogger } from "@qala/core";

const logger = new Logger(env.LOG_LEVEL, env.LOG_FORMAT); // "json" in production

export const kernel = {
  middleware: [requestLogger(logger)],
};
```

```json
{"time":"2026-11-25T10:32:31.416Z","level":"info","message":"GET /tasks","request_id":"abc-1","method":"GET","path":"/tasks","status":200,"duration_ms":8}
```

`requestLogger` logs `request_id`, `method`, `path`, `status` and `duration_ms` once per request. An unexpected error
(500) is logged by the app with the same fields plus `stack`.

### Per-request logger

`ctx.log` is a child of the app's logger that adds `request_id` to every line, so your own log lines can be joined
with the access log:

```ts
store: action({ body: NewTask }, async ({ body, ctx }) => {
  const task = await tasks.create(body);
  ctx.log.info("Task created", { task_id: task.id });
  return task;
}),
```

`logger.child({ ... })` makes such a logger anywhere (fields are merged, the child's win).

## Health and readiness

Two probes are answered by the framework, before global middleware (so authentication and request logs do not apply
to them):

| Path      | Meaning   | Answer |
| --------- | --------- | ------ |
| `GET /health` | liveness: the process is up and serving | always `200 {"status":"ok"}` |
| `GET /ready`  | readiness: send traffic here | `200 {"status":"ready"}`; `503 {"status":"shutting_down"}` once [graceful shutdown](/guide/deployment#graceful-shutdown) started; with a `Database` provider it runs `select 1` and answers `503 {"status":"unavailable","checks":{"database":"down"}}` if that fails or takes longer than `readyTimeout` (default 1000 ms) |

A route of your own on `/health` or `/ready` takes precedence. To turn the probes off, or change the timeout:

```ts
export const kernel = {
  health: false,      // no built-in /health and /ready
  readyTimeout: 500,  // ms /ready waits for the database
};
```

The same options (`health`, `readyTimeout`, `requestId`) can be passed to `createApp()` directly.

Kubernetes example:

```yaml
livenessProbe:
  httpGet: { path: /health, port: 3000 }
readinessProbe:
  httpGet: { path: /ready, port: 3000 }
  periodSeconds: 5
```

Point the liveness probe at `/health`, not `/ready`: a database outage should take the pod out of the load balancer,
not restart it.
