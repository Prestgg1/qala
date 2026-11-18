---
title: Performance
---

# Performance


The [example app](https://github.com/Prestgg1/qala/tree/main/examples/tasks) measured as a native binary (`--optimization speed`) and on Bun: same code, byte-identical responses, PostgreSQL on the same 4-core machine, server pinned to 3 cores, load generator on the 4th, 10 s per scenario, 50 connections. One busy desktop (load ~5–7), single runs — treat differences under ~30% as noise.

| | native | Bun |
|---|---|---|
| startup | 7 ms | 173 ms |
| memory idle / peak | 5 MB / 8 MB | 58 MB / 148 MB |
| binary size | ~5 MB, links only libc and libm | — |
| `GET /tasks?limit=50` | **4 807 req/s** (p99 22 ms) | 3 348 req/s (p99 32 ms) |
| `GET /tasks/:id` | **9 158 req/s** (p99 11 ms) | 5 888 req/s (p99 35 ms) |
| `GET /tasks?q=` (ILIKE search) | **2 964 req/s** (p99 29 ms) | 1 454 req/s (p99 180 ms) |
| `POST /comments` (write + auth) | 406 req/s | 382 req/s |

Why it is fast: `qala generate` writes a typed row decoder for every model (`.qala/models.gen.ts`), rows come off the wire as text arrays and are decoded straight into their static shape, timestamps are converted with string operations instead of `Date`, and each action serialises its result inside a generic wrapper, so `JSON.stringify` is compiled for the real type. Before these changes a 50-row list ran at 1 277 req/s natively — the same code walked untyped records in scriptc's dynamic tier.

## The example app benchmark

The full methodology and results come from the [Tasks example app](./example-app).
