---
"@qala/core": minor
"@qala/cli": minor
---

Graceful shutdown and request limits. On SIGTERM/SIGINT `serve()` stops accepting connections, closes WebSockets (1001) and streams, waits up to `shutdownTimeout` for in-flight requests, runs `onShutdown` hooks (`app.onShutdown`, or `export function onShutdown` in `app/kernel.ts`), closes the database pool and exits (0 if drained, 1 on timeout); workers are stopped the same way. New `serve` options: `headersTimeout` (slowloris protection, 408; now enforced in the native binary), `requestTimeout` (408), `keepAliveTimeout`, `maxHeaderSize` (431), `wsMaxMessage` (1009), `shutdownTimeout`, `handleSignals`. Behavior change: the process now handles SIGTERM/SIGINT itself; pass `handleSignals: false` to opt out. `startWorkers` returns a `Workers` handle instead of installing signal handlers.
