# Deployment

`qala build` produces one executable that links only glibc (and libm). Deploying a Qala app means copying that file somewhere with glibc, giving it environment variables, and running migrations before it starts.

## What the binary needs

| | |
| --- | --- |
| OS | Linux with glibc (Debian, Ubuntu, RHEL, distroless/cc). Alpine (musl) does **not** work. Build on the same CPU architecture you deploy to. |
| Config | Environment variables declared in `.env.example`. A `.env` file in the working directory is read if present; real variables win. Missing variables are all reported at startup. |
| Network | Listens on `0.0.0.0:$PORT`. Put a reverse proxy (Caddy, nginx, a cloud load balancer) in front for TLS. |
| Database | PostgreSQL 14+. The client has **no TLS yet**: keep the database on a private network. |

Check a build machine with `qala doctor` first: it verifies Bun, Node.js, scriptc, clang and the database.

## Docker

The example app ships a three-stage [Dockerfile](https://github.com/Prestgg1/qala/blob/main/examples/tasks/Dockerfile): a build stage (Bun, Node.js, clang), a migrate stage, and a runtime stage with only the binary on `distroless/cc`, running as a non-root user.

```sh
docker build -f examples/tasks/Dockerfile -t qala-tasks .
docker build -f examples/tasks/Dockerfile --target migrate -t qala-tasks-migrate .

docker run --rm -e DATABASE_URL=postgres://… qala-tasks-migrate
docker run -p 3000:3000 -e DATABASE_URL=postgres://… -e API_TOKEN=… qala-tasks
```

The runtime image is a few MB on top of distroless. Copy only `dist/app`: `qala build` also leaves the LLVM IR (`dist/main.ll`) next to it, which is tens of MB and not needed at runtime.

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
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

With `serve(app, { workers: "auto" })` the binary forks one process per core itself; do not also run several instances of the unit on one machine.

## Migrations

`qala migrate` runs on Bun, not inside the binary. Run it as a separate step before the new version starts (a CI job, a Kubernetes `Job` or init container, the `migrate` Docker stage). Only one migrator should run at a time.

## Production checklist

- [ ] `LOG_FORMAT=json` (if your app reads it) so logs are machine-readable
- [ ] Secrets come from the environment, never from a committed `.env`
- [ ] TLS terminates at a reverse proxy; the database is on a private network
- [ ] A `/health` route exists and the orchestrator probes it
- [ ] Migrations run once, before the rollout
- [ ] `rateLimit` is per process: with `workers: "auto"` the effective limit is multiplied by the core count
- [ ] Build and runtime use the same architecture (build arm64 on arm64)

Known gaps being worked on: Postgres TLS, graceful draining of in-flight requests on SIGTERM, request size/timeout limits. Track them in [CHANGELOG.md](https://github.com/Prestgg1/qala/blob/main/CHANGELOG.md).
