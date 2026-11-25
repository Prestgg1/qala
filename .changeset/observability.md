---
"@qala/core": minor
"@qala/cli": minor
---

Observability: request ids (`x-request-id` reused when valid, otherwise generated; `ctx.requestId`; echoed in the response), `ctx.log` per-request logger and `Logger.child()`, `requestLogger` / 500 log lines with `request_id`, `method`, `path`, `status`, `duration_ms` (the `ms` field is renamed), and built-in `GET /health` and `GET /ready` (503 while shutting down or when the database does not answer). New `createApp` options `health`, `readyTimeout` and `requestId`, also read from `app/kernel.ts` by the generated main. Behavior change: `/health` and `/ready` now answer by default unless the app defines them; pass `health: false` to opt out.
