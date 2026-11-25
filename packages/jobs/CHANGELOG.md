# @qala/jobs

## 0.1.0

### Minor Changes

- 83ba5dc: New package: a PostgreSQL-backed job queue. `defineJob(name, schema, handler)`, `jobs.enqueue(job, payload, { delay, queue, maxAttempts, tx })` (transactional/outbox enqueue), workers that claim with `FOR UPDATE SKIP LOCKED`, wake on LISTEN/NOTIFY, retry with exponential backoff, mark jobs dead after `max_attempts`, recover stuck jobs, and stop gracefully with `jobs.start(app)` on shutdown. Compiles natively with scriptc.

### Patch Changes

- Updated dependencies [efaeba0]
- Updated dependencies [d502e84]
- Updated dependencies [564e9da]
- Updated dependencies [265c322]
- Updated dependencies [1fa3ef7]
- Updated dependencies [fea7614]
- Updated dependencies [05c8c01]
  - @qala/core@1.0.0
