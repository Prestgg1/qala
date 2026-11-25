# Background jobs

`@qala/jobs` is a job queue stored in your PostgreSQL database: no Redis, no extra service. Jobs are typed and
validated, can be enqueued inside a transaction (they exist only if it commits), are claimed with
`SELECT … FOR UPDATE SKIP LOCKED` so any number of processes can work one queue, retry with exponential backoff and are
marked dead after their last attempt. Everything compiles with scriptc, so the worker runs inside the native binary.

## Setup

```sh
bun add @qala/jobs
qala make:jobs-table        # database/migrations/NNNN_create_qala_jobs.sql
qala migrate
```

Map the package in `tsconfig.json` like `@qala/core` (scriptc compiles it from source):

```json
"paths": { "@qala/jobs": ["./node_modules/@qala/jobs/src/index.ts"] }
```

The migration is plain SQL you own; `jobsTableSql(table?)` from `@qala/jobs` returns the same statements if you prefer
to create the table yourself. The table:

| column | |
|---|---|
| `id` | `bigserial`; `enqueue` resolves it as a string |
| `queue`, `name`, `payload` | queue (default `"default"`), job name, JSON payload (`jsonb`) |
| `status` | `pending` → `running` → `completed`, or back to `pending` for a retry, or `dead` |
| `attempts`, `max_attempts` | attempts made so far (counted when claimed) and the limit |
| `run_at` | not claimed before this time (delays and retry backoff) |
| `locked_at`, `locked_by` | set while a worker runs the job |
| `last_error` | message of the last failure |
| `created_at`, `finished_at` | `finished_at` is set when the job completes or dies |

## Defining jobs

```sh
qala make:job send-welcome   # app/application/jobs/send-welcome.job.ts
```

```ts
// app/application/jobs/send-welcome.job.ts
import { t } from "@qala/core";
import { defineJob } from "@qala/jobs";
import { Mailer } from "../mailer";

export const SendWelcome = defineJob(
  "send-welcome",                                   // unique name, stored in the table
  t.object({ userId: t.uuid(), email: t.string() }), // payload schema
  async (payload, job) => {                          // payload: { userId: string; email: string }
    await job.container.get(Mailer).welcome(payload.email);
  },
  { maxAttempts: 3, queue: "mail" },                 // defaults: 5 attempts, queue "default"
);
```

- The payload is validated when it is enqueued (`ValidationError` otherwise) and again before the handler runs. It is
  stored as JSON: use JSON-friendly schemas (ISO strings for dates).
- `job` has `id`, `name`, `queue`, `attempt` (1 on the first run), `maxAttempts` and `container`, the app's container,
  so handlers can use any service.
- A handler that throws (or rejects) is retried; handlers should be idempotent, since a job can run again after a crash.

## The queue in DI

`Jobs` comes from a package, so it is provided in `app/providers.ts` with the list of jobs its workers run:

```ts
// app/providers.ts
import { Database, provide, type Provider } from "@qala/core";
import { Jobs } from "@qala/jobs";
import { SendWelcome } from "./application/jobs/send-welcome.job";

export const providers: Provider[] = [provide(Jobs, (c) => new Jobs(c.get(Database), [SendWelcome]))];
```

Options: `new Jobs(db, jobs, { table: "qala_jobs", channel: "qala_jobs", logger })`. Any class can then ask for `Jobs` in
its constructor (`qala check` allows `@qala/jobs` in `app/application`).

## Enqueueing

```ts
export class UserService {
  constructor(private readonly db: Database, private readonly jobs: Jobs) {}

  async register(input: UserInput): Promise<User> {
    // Outbox: the job is part of the transaction. A rollback leaves no job; workers are notified at COMMIT.
    return this.db.transaction(async (tx) => {
      const user = await tx.table(User).insert(input);
      await this.jobs.enqueue(SendWelcome, { userId: user.id, email: user.email }, { tx });
      return user;
    });
  }
}
```

`jobs.enqueue(job, payload, options)` resolves the job's id. Options:

| option | default | |
|---|---|---|
| `tx` | none | a `Transaction` from `db.transaction`: enqueue as part of it |
| `delay` | `0` | milliseconds before the job may run |
| `queue` | the job's queue | |
| `maxAttempts` | the job's `maxAttempts` | |

## Workers

Start one from `onStart` in `app/kernel.ts`:

```ts
// app/kernel.ts
export function onStart(app: App): void {
  app.container.get(Jobs).start(app, { concurrency: 4 });
}
```

`jobs.start(app, options)` starts a worker in this process and registers an `app.onShutdown` hook: on SIGTERM/SIGINT
the worker stops claiming, waits up to `shutdownTimeout` for running jobs, and only then does the database pool close.

**Every process or the primary only?** Claims use `FOR UPDATE SKIP LOCKED`, so running a worker in every process (the
example above; with `workers: 4` that is 4 × `concurrency` jobs at once) is safe and spreads the load. To keep jobs off
the HTTP worker processes, start it only in the primary: `if (process.primary) …` with
`onStart(app, process: { primary: boolean })`. You can also run a separate binary or entry point that only works the
queue (`jobs.work(options).start()`), e.g. with `queues: ["mail"]`.

| option | default | |
|---|---|---|
| `concurrency` | `1` | jobs this worker runs at the same time |
| `queues` | every queue | e.g. `["mail", "default"]` |
| `pollInterval` | `1000` | ms between polls; new jobs wake the worker at once via LISTEN/NOTIFY, polls find delayed jobs and retries |
| `listen` | `true` | LISTEN for new jobs (one shared connection per `Database`) |
| `backoff` | `1000` | first retry delay in ms; doubled for each further attempt (1 s, 2 s, 4 s, …) |
| `maxBackoff` | `3600000` | cap of the retry delay |
| `visibilityTimeout` | `300000` | a `running` job locked longer than this is considered abandoned (crashed process) and retried, or marked dead if it was its last attempt; must be longer than your slowest job |
| `shutdownTimeout` | `10000` | how long `start(app)`'s shutdown hook waits for running jobs |

A job still running when the shutdown timeout passes keeps its lock; after `visibilityTimeout` another worker runs it
again.

## Failures and maintenance

- A failed attempt stores the error in `last_error` and reschedules the job (`run_at = now() + backoff · 2^(attempt-1)`).
  After `max_attempts` attempts the job is `dead`. Failures are logged through `logger` (or `console.error`).
- `jobs.retry(id)` puts a dead (or completed) job back with a fresh attempt budget.
- Completed jobs stay in the table; `jobs.prune(olderThanMs = 1 day)` deletes old ones (run it from a job or a cron).
- Inspect the queue with SQL: `select status, count(*) from qala_jobs group by status`.

## Testing

`jobs.drain()` runs every job that is due in the current process and resolves how many ran: enqueue in a test, drain,
assert. `jobs.work(options)` returns a `Worker` with `start()`, `stop(timeout)`, `drain()`, `running` and `processed`.

## Native builds

The package is written for scriptc's static subset and is tested natively (enqueue, retries, dead jobs, transactional
enqueue, stuck-job recovery, LISTEN wakeup and graceful shutdown) in CI. The job payload is decoded from JSON and
validated by its schema, which scriptc treats as a checked dynamic value (warning SC6104 for `defineJob`); the handler
receives it after validation, so the types it relies on hold.
