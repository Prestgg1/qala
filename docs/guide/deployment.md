# Deployment

`qala build` produces one executable that links only glibc (and libm). Deploying a Qala app means copying that file somewhere with glibc, giving it environment variables, and running migrations before it starts.

## What the binary needs

| | |
| --- | --- |
| OS | Linux with glibc (Debian, Ubuntu, RHEL, distroless/cc). Alpine (musl) does **not** work. Build on the same CPU architecture you deploy to. |
| Config | Environment variables declared in `.env.example`. A `.env` file in the working directory is read if present; real variables win. Missing variables are all reported at startup. |
| Network | Listens on `0.0.0.0:$PORT`. Put a reverse proxy (Caddy, nginx, a cloud load balancer) in front for TLS. |
| Database | PostgreSQL 14+, over TLS when the server offers it (see [Database TLS](#database-tls)). |

Check a build machine with `qala doctor` first: it verifies Bun, Node.js, scriptc, clang and the database.

## Docker

The example app ships a three-stage [Dockerfile](https://github.com/Prestgg1/qala/blob/main/examples/tasks/Dockerfile): a build stage (Bun, Node.js, clang), a migrate stage, and a runtime stage with only the binary on `distroless/cc`, running as a non-root user.

```sh
docker build -f examples/tasks/Dockerfile -t qala-tasks .
docker build -f examples/tasks/Dockerfile --target migrate -t qala-tasks-migrate .

docker run --rm -e DATABASE_URL=postgres://… qala-tasks-migrate
docker run -p 3000:3000 -e DATABASE_URL=postgres://… -e API_TOKEN=… qala-tasks
```

The runtime image is a few MB on top of distroless. Copy only `dist/app`: (`qala build` deletes the LLVM IR scriptc writes next to it; pass `--keep-ir` to keep it for debugging.)

## systemd

```ini
# /etc/systemd/system/my-api.service
[Unit]
Description=my-api
After=network-online.target

[Service]
ExecStart=/opt/my-api/app
WorkingDirectory=/opt/my-api
EnvironmentFile=/etc/my-api.env
User=my-api
Restart=on-failure
TimeoutStopSec=30
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

With `serve(app, { workers: "auto" })` the binary forks one process per core itself; do not also run several instances of the unit on one machine.

## Graceful shutdown

On SIGTERM or SIGINT the server shuts down in this order, then exits:

1. Stop accepting connections and close idle keep-alive connections. Responses still being written carry `connection: close`.
2. Close WebSockets with code 1001 ("going away") and end streamed responses (SSE), so clients reconnect elsewhere. New WebSocket upgrades get 503.
3. Wait up to `shutdownTimeout` ms (default 10 000) for in-flight requests to finish.
4. Run `onShutdown` hooks from `app/kernel.ts` and `app.onShutdown(...)`, last registered first.
5. Close the database pool and the LISTEN connection.

The exit code is 0 when everything drained in time and 1 when the timeout cut requests off. A second signal exits at once. With `workers`, the primary forwards the signal to every worker and exits after all of them finished.

```ts
// app/kernel.ts
export async function onShutdown(app: App): Promise<void> {
  await app.container.get(Mailer).flush(); // anything that must finish before the process exits
}
```

Give the orchestrator a grace period longer than `shutdownTimeout`, because it sends SIGKILL when the period ends. Kubernetes' `terminationGracePeriodSeconds` defaults to 30 s, which fits. Docker's default is 10 s, the same as `shutdownTimeout`, so raise it: `docker run --stop-timeout 15`, or `stop_grace_period: 15s` in Compose. The binary handles SIGTERM itself, so it can run as PID 1 in the container without an init process. In Kubernetes, a short `preStop` sleep (e.g. 5 s) lets the endpoint leave the load balancer before draining starts. With systemd, `KillSignal=SIGTERM` (the default) and `TimeoutStopSec=30` fit.

In tests, or to stop a server from code, call `await app.shutdown(timeoutMs)`. It returns whether everything drained in time and never exits the process. Pass `handleSignals: false` to `serve` to install no signal handlers.

## Request limits

`serve` limits what one client can make the server hold. Set them in `app/kernel.ts`:

```ts
export const serveOptions = {
  bodyLimit: 1024 * 1024,   // bytes; larger bodies get 413 (multipart uploads have their own per-action limits)
  headersTimeout: 10_000,   // ms to send the complete request head, after connecting or after the previous response; then 408
  requestTimeout: 30_000,   // ms to send the whole body; then 408
  keepAliveTimeout: 5_000,  // ms an idle keep-alive connection stays open
  maxHeaderSize: 16 * 1024, // bytes of request line + headers; larger gets 431
  wsMaxMessage: 16 * 1024 * 1024, // bytes per WebSocket message (all fragments); larger closes with 1009
  shutdownTimeout: 10_000,  // ms to drain on SIGTERM
};
```

The values above are the defaults. `headersTimeout` is the slowloris protection: a client that trickles its headers is disconnected even if it keeps sending bytes. The native binary enforces every limit itself, because scriptc's node:http does not apply `headersTimeout`. Under Bun (`qala dev`), Bun.serve applies the body, keep-alive and WebSocket limits, but its idle timer only starts after the request head is complete, and it works in steps of about four seconds.

Behind a reverse proxy, keep the proxy's own timeouts and body limit at or below these, and the proxy's upstream keep-alive timeout below `keepAliveTimeout`, so the proxy never reuses a connection the app is closing.

## Database TLS

TLS is set in `DATABASE_URL` with libpq's `sslmode`, so the same URL works with `psql`:

```sh
DATABASE_URL=postgres://app:secret@db.example.com:5432/app?sslmode=verify-full&sslrootcert=/etc/ssl/db-ca.pem
```

| `sslmode` | Encrypted | Certificate checked | Host name checked |
| --- | --- | --- | --- |
| `disable` | no | | |
| `prefer` (default) | if the server offers TLS | no | no |
| `require` | yes, or the connection fails | no | no |
| `verify-ca` | yes | yes | no |
| `verify-full` | yes | yes | yes |

Use **`verify-full`** in production. `prefer` and `require` encrypt but cannot tell your server from an impostor. `sslrootcert` is the path of a PEM file with the CA that signed the server's certificate (managed databases publish theirs, e.g. the RDS or Azure CA bundle); without it the system's CAs are used, which is right for servers with publicly trusted certificates. `ssl=true` (the node-postgres and Prisma spelling) means `require`. Client certificates (`sslcert` / `sslkey`) are not supported yet.

In the distroless image, copy the CA file in and point `sslrootcert` at it:

```dockerfile
COPY db-ca.pem /app/db-ca.pem
```

## Migrations

`qala migrate` runs on Bun, not inside the binary. Run it as a separate step before the new version starts (a CI job, a Kubernetes `Job` or init container, the `migrate` Docker stage). Only one migrator should run at a time.

## Production checklist

- [ ] `LOG_FORMAT=json` (if your app reads it) so logs are machine-readable
- [ ] Secrets come from the environment, never from a committed `.env`
- [ ] TLS terminates at a reverse proxy; `DATABASE_URL` uses `sslmode=verify-full`
- [ ] A `/health` route exists and the orchestrator probes it
- [ ] Migrations run once, before the rollout
- [ ] `rateLimit` is per process: with `workers: "auto"` the effective limit is multiplied by the core count
- [ ] Build and runtime use the same architecture (build arm64 on arm64)
- [ ] The orchestrator's stop grace period is longer than `shutdownTimeout` (see [Graceful shutdown](#graceful-shutdown))
- [ ] `bodyLimit` and the timeouts in `serveOptions` fit your largest legitimate request; the proxy's limits are no looser
