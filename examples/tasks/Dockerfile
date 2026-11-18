# syntax=docker/dockerfile:1
# Build from the repository root:  docker build -f examples/tasks/Dockerfile -t qala-tasks .
# Your own app needs only the "build" stage pointed at its directory.

# ---- build: Bun + Node.js (scriptc install) + clang (scriptc links with it) ----
FROM oven/bun:1.3-debian AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends clang libsodium-dev ca-certificates curl \
 && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile
WORKDIR /src/examples/tasks
RUN bun ../../packages/cli/src/bin.ts build --optimization speed

# ---- migrate: one-off job image (`docker run --rm qala-tasks-migrate`) ----
FROM build AS migrate
CMD ["bun", "../../packages/cli/src/bin.ts", "migrate"]

# ---- runtime: only the binary; it links nothing but glibc/libm ----
FROM gcr.io/distroless/cc-debian12:nonroot AS runtime
WORKDIR /app
COPY --from=build /src/examples/tasks/dist/app /app/app
ENV PORT=3000 LOG_FORMAT=json
EXPOSE 3000
USER nonroot
ENTRYPOINT ["/app/app"]
