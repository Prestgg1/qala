---
"@qala/jobs": minor
---

New package: a PostgreSQL-backed job queue. `defineJob(name, schema, handler)`, `jobs.enqueue(job, payload, { delay, queue, maxAttempts, tx })` (transactional/outbox enqueue), workers that claim with `FOR UPDATE SKIP LOCKED`, wake on LISTEN/NOTIFY, retry with exponential backoff, mark jobs dead after `max_attempts`, recover stuck jobs, and stop gracefully with `jobs.start(app)` on shutdown. Compiles natively with scriptc.
