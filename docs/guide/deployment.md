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
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

With `serve(app, { workers: "auto" })` the binary forks one process per core itself; do not also run several instances of the unit on one machine.

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

Known gaps being worked on: graceful draining of in-flight requests on SIGTERM, request size/timeout limits. Track them in [CHANGELOG.md](https://github.com/Prestgg1/qala/blob/main/CHANGELOG.md).
