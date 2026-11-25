import { type App, Container, type Database, type DbRow, type DbValue, type Logger, type Subscription, type Transaction } from "@qala/core";
import { JobContext, type Job, type JobDef } from "./job";

export type JobsOptions = {
  /** Table name (default "qala_jobs"); must match the migration. */
  table?: string;
  /** LISTEN/NOTIFY channel used to wake workers (default "qala_jobs"). */
  channel?: string;
  /** Container handed to handlers as `job.container` (default: `app.container` once `start(app)` runs). */
  container?: Container;
  /** Where worker errors are logged (failed jobs, lost database connections). Default: console.error. */
  logger?: Logger;
};

export type EnqueueOptions = {
  /** Run no earlier than this many milliseconds from now (default 0). */
  delay?: number;
  /** Queue (default: the job's queue). */
  queue?: string;
  /** Attempts before the job is dead (default: the job's maxAttempts). */
  maxAttempts?: number;
  /**
   * Enqueue inside this transaction: the job exists (and workers are notified) only if it commits. This is the
   * outbox pattern: `db.transaction(async (tx) => { await tx.table(User).insert(u); await jobs.enqueue(SendWelcome, p, { tx }); })`.
   */
  tx?: Transaction;
};

export type WorkerOptions = {
  /** Queues to work on (default: every queue). */
  queues?: string[];
  /** Jobs run at the same time by this worker (default 1). */
  concurrency?: number;
  /** Milliseconds between polls when no notification arrives (default 1000). */
  pollInterval?: number;
  /** A running job whose lock is older than this (ms) is considered abandoned and retried (default 300000). */
  visibilityTimeout?: number;
  /** First retry delay in ms; doubled for every further attempt (default 1000). */
  backoff?: number;
  /** Upper bound of the retry delay in ms (default 3600000). */
  maxBackoff?: number;
  /** LISTEN for new jobs instead of only polling (default true). */
  listen?: boolean;
  /** Milliseconds `stop()` waits for running jobs during app shutdown (default 10000). */
  shutdownTimeout?: number;
};

/** One job as claimed from the table. */
export class ClaimedJob {
  constructor(
    readonly id: string,
    readonly queue: string,
    readonly name: string,
    readonly payload: string,
    readonly attempt: number,
    readonly maxAttempts: number,
  ) {}
}

function text(row: DbRow, key: string): string {
  const v = row[key];
  return v === null || v === undefined ? "" : String(v);
}

function int(row: DbRow, key: string): number {
  const v = row[key];
  return typeof v === "number" ? v : Number(v ?? 0);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message === "" ? error.name : error.message;
  return String(error);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Retry delay after `attempt` failed attempts: backoff · 2^(attempt-1), capped. */
export function retryDelay(attempt: number, backoff: number, maxBackoff: number): number {
  const exp = Math.max(0, attempt - 1);
  const delay = backoff * 2 ** Math.min(exp, 40);
  return Math.min(delay, maxBackoff);
}

/**
 * The queue: enqueue jobs, start workers. Register it in `app/providers.ts`:
 *
 *   provide(Jobs, (c) => new Jobs(c.get(Database), [SendWelcome, ResizeImage]))
 */
export class Jobs {
  readonly table: string;
  readonly channel: string;
  container: Container;
  private readonly logger: Logger | null;
  private readonly registry = new Map<string, JobDef>();

  constructor(
    readonly db: Database,
    jobs: JobDef[] = [],
    options: JobsOptions = {},
  ) {
    this.table = options.table ?? "qala_jobs";
    this.channel = options.channel ?? "qala_jobs";
    this.container = options.container ?? new Container([]);
    this.logger = options.logger ?? null;
    for (const job of jobs) this.register(job);
  }

  /** Adds a job definition (workers only run jobs they know). */
  register(job: JobDef): void {
    this.registry.set(job.name, job);
  }

  /** The definition registered under `name`, or null. */
  definition(name: string): JobDef | null {
    return this.registry.get(name) ?? null;
  }

  /**
   * Stores a job and wakes the workers; resolves its id. The payload is validated against the job's schema first
   * (`ValidationError` otherwise). With `{ tx }` it is part of that transaction.
   */
  enqueue<P>(job: Job<P>, payload: P, options: EnqueueOptions = {}): Promise<string> {
    const json = JSON.stringify(payload);
    return this.enqueueJson(job, json === undefined ? "null" : json, options);
  }

  /** `enqueue` with an already serialised JSON payload (validated all the same). */
  async enqueueJson(job: JobDef, payload: string, options: EnqueueOptions = {}): Promise<string> {
    const checked = job.check(JSON.parse(payload));
    const body = JSON.stringify(checked);
    const queue = options.queue ?? job.queue;
    const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? job.maxAttempts));
    const delay = Math.max(0, options.delay ?? 0);
    const t = quoteIdent(this.table);
    // One round trip: insert, then NOTIFY (delivered at COMMIT, so a rolled-back transaction wakes nobody).
    const sql = `with j as (insert into ${t} (queue, name, payload, max_attempts, run_at) values ($1, $2, $3::jsonb, $4, now() + $5::double precision * interval '1 millisecond') returning id) select j.id::text as id, pg_notify($6, $1) from j`;
    const params: DbValue[] = [queue, job.name, body === undefined ? "null" : body, maxAttempts, delay, this.channel];
    const tx = options.tx;
    const rows = tx === undefined ? await this.db.query(sql, params) : await tx.query(sql, params);
    const row = rows[0];
    return row === undefined ? "" : text(row, "id");
  }

  /** Puts a dead (or completed) job back into its queue with a fresh attempt budget. True if the job exists. */
  async retry(id: string): Promise<boolean> {
    const t = quoteIdent(this.table);
    const n = await this.db.execute(
      `update ${t} set status = 'pending', attempts = 0, run_at = now(), locked_at = null, locked_by = null, finished_at = null where id = $1::bigint and status in ('dead', 'completed')`,
      [id],
    );
    if (n > 0) await this.db.notify(this.channel, "");
    return n > 0;
  }

  /** Deletes completed jobs that finished more than `olderThan` ms ago (default one day); resolves the count. */
  prune(olderThan: number = 86_400_000): Promise<number> {
    const t = quoteIdent(this.table);
    return this.db.execute(`delete from ${t} where status = 'completed' and finished_at < now() - $1::double precision * interval '1 millisecond'`, [olderThan]);
  }

  /** A worker for this queue; call `start()` on it (or use `jobs.start(app)`). */
  work(options: WorkerOptions = {}): Worker {
    return new Worker(this, options);
  }

  /**
   * Starts a worker in this process and stops it gracefully on `app.shutdown()` (stop claiming, wait up to
   * `shutdownTimeout` for running jobs). Handlers get `app.container` unless the Jobs has its own.
   */
  start(app: App, options: WorkerOptions = {}): Worker {
    this.container = app.container;
    const worker = this.work(options);
    const timeout = options.shutdownTimeout ?? 10_000;
    app.onShutdown(async () => {
      await worker.stop(timeout);
    });
    worker.start();
    return worker;
  }

  /**
   * Runs every job that is due now in this process, until none is left (failed ones are rescheduled as usual).
   * Resolves the number of jobs run. Meant for tests and scripts.
   */
  drain(options: WorkerOptions = {}): Promise<number> {
    return this.work({ ...options, listen: false }).drain();
  }

  /** Logs a worker problem. */
  report(message: string, fields: Record<string, unknown>): void {
    const logger = this.logger;
    if (logger !== null) logger.error(message, fields);
    else console.error(`[jobs] ${message} ${JSON.stringify(fields)}`);
  }
}

/**
 * Claims jobs with `SELECT … FOR UPDATE SKIP LOCKED` (so any number of workers and processes can share a queue),
 * runs up to `concurrency` at once, retries failures with exponential backoff and marks a job dead after its last
 * attempt. New jobs wake it via LISTEN/NOTIFY; it also polls, which picks up delayed jobs and retries.
 */
export class Worker {
  readonly id: string;
  private readonly queues: string;
  private readonly concurrency: number;
  private readonly pollInterval: number;
  private readonly visibilityTimeout: number;
  private readonly backoff: number;
  private readonly maxBackoff: number;
  private readonly useListen: boolean;
  /** Jobs running right now. */
  running = 0;
  /** Jobs finished (completed or failed) by this worker. */
  processed = 0;
  private started = false;
  private stopping = false;
  private looping = false;
  private woken = false;
  private lastRecovery = 0;
  private subscription: Subscription | null = null;
  private readonly wakers: (() => void)[] = [];
  private readonly idleWaiters: (() => void)[] = [];

  constructor(
    private readonly jobs: Jobs,
    options: WorkerOptions = {},
  ) {
    this.id = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const queues = options.queues ?? [];
    this.queues = queues.join(",");
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
    this.pollInterval = Math.max(10, options.pollInterval ?? 1000);
    this.visibilityTimeout = Math.max(1, options.visibilityTimeout ?? 300_000);
    this.backoff = Math.max(0, options.backoff ?? 1000);
    this.maxBackoff = Math.max(0, options.maxBackoff ?? 3_600_000);
    this.useListen = options.listen ?? true;
  }

  /** True between `start()` and `stop()`. */
  get active(): boolean {
    return this.started && !this.stopping;
  }

  /** Starts polling (and listening); returns at once. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.looping = true;
    this.loop().then(
      () => {},
      () => {},
    );
  }

  /**
   * Stops claiming new jobs and waits up to `timeout` ms for the running ones. Resolves true if they all finished.
   * Jobs still running after the timeout keep their lock; another worker retries them after `visibilityTimeout`.
   */
  async stop(timeout: number = 10_000): Promise<boolean> {
    this.stopping = true;
    this.wake();
    const subscription = this.subscription;
    this.subscription = null;
    if (subscription !== null) {
      try {
        await subscription.unlisten();
      } catch {}
    }
    return this.idle(timeout);
  }

  /** Runs due jobs until none is left; resolves how many ran. */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      await this.recover();
      const batch = await this.claim(this.concurrency);
      if (batch.length === 0) return total;
      const runs: Promise<void>[] = [];
      for (const job of batch) runs.push(this.process(job));
      for (const run of runs) await run;
      total += batch.length;
    }
  }

  private async loop(): Promise<void> {
    if (this.useListen) {
      try {
        this.subscription = await this.jobs.db.listen(this.jobs.channel, () => this.wake());
      } catch (error) {
        this.jobs.report("LISTEN failed, polling only", { error: errorMessage(error) });
      }
    }
    while (!this.stopping) {
      let full = false;
      try {
        const now = Date.now();
        if (now - this.lastRecovery >= this.pollInterval) {
          this.lastRecovery = now;
          await this.recover();
        }
        const free = this.concurrency - this.running;
        if (free > 0 && !this.stopping) {
          const batch = await this.claim(free);
          for (const job of batch) this.spawn(job);
          // A full batch means more may be waiting: claim again once a slot frees up.
          full = batch.length === free;
        }
      } catch (error) {
        this.jobs.report("worker poll failed", { error: errorMessage(error) });
      }
      if (this.stopping) break;
      if (full && this.running < this.concurrency) continue;
      await this.nap(this.pollInterval);
    }
    this.looping = false;
    this.wakeIdle();
  }

  private spawn(job: ClaimedJob): void {
    this.process(job).then(
      () => {},
      () => {},
    );
  }

  /** Sleeps until `ms` passed or something calls `wake()` (a notification, a finished job, `stop()`). */
  private nap(ms: number): Promise<void> {
    if (this.woken) {
      this.woken = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        this.wakers.splice(0, this.wakers.length);
        resolve();
      }, ms);
      this.wakers.push(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private wake(): void {
    if (this.wakers.length === 0) {
      this.woken = true;
      return;
    }
    this.woken = false;
    const wakers = this.wakers.splice(0, this.wakers.length);
    for (const w of wakers) w();
  }

  private isIdle(): boolean {
    return this.running === 0 && !this.looping;
  }

  private idle(timeout: number): Promise<boolean> {
    if (this.isIdle()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, timeout);
      this.idleWaiters.push(() => {
        if (settled || !this.isIdle()) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private wakeIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters.splice(0, this.idleWaiters.length);
    for (const w of waiters) w();
  }

  /** Claims up to `limit` due jobs: marks them running, counts the attempt, takes the lock. */
  async claim(limit: number): Promise<ClaimedJob[]> {
    const t = quoteIdent(this.jobs.table);
    const rows = await this.jobs.db.query(
      `update ${t} set status = 'running', attempts = attempts + 1, locked_at = now(), locked_by = $1
       where id in (
         select id from ${t}
         where status = 'pending' and run_at <= now() and ($2 = '' or queue = any(string_to_array($2, ',')))
         order by run_at, id
         limit $3
         for update skip locked
       )
       returning id::text as id, queue, name, payload::text as payload, attempts, max_attempts`,
      [this.id, this.queues, limit],
    );
    const out: ClaimedJob[] = [];
    for (const row of rows) out.push(new ClaimedJob(text(row, "id"), text(row, "queue"), text(row, "name"), text(row, "payload"), int(row, "attempts"), int(row, "max_attempts")));
    // Oldest first, as claimed (UPDATE … RETURNING does not keep the subquery's order).
    out.sort((a, b) => Number(a.id) - Number(b.id));
    return out;
  }

  /** Puts running jobs whose lock is older than the visibility timeout back (or marks them dead). */
  async recover(): Promise<number> {
    const t = quoteIdent(this.jobs.table);
    return this.jobs.db.execute(
      `update ${t} set
         status = case when attempts >= max_attempts then 'dead' else 'pending' end,
         finished_at = case when attempts >= max_attempts then now() else null end,
         last_error = 'visibility timeout: worker ' || coalesce(locked_by, '?') || ' did not finish the job in time',
         locked_at = null, locked_by = null
       where status = 'running' and locked_at < now() - $1::double precision * interval '1 millisecond'`,
      [this.visibilityTimeout],
    );
  }

  private async process(job: ClaimedJob): Promise<void> {
    this.running++;
    try {
      let failure = "";
      try {
        const def = this.jobs.definition(job.name);
        if (def === null) throw new Error(`unknown job "${job.name}" (not registered with this Jobs)`);
        const payload = def.check(JSON.parse(job.payload));
        await def.runner(payload, new JobContext(job.id, job.name, job.queue, job.attempt, job.maxAttempts, this.jobs.container));
      } catch (error) {
        failure = errorMessage(error);
        if (failure === "") failure = "failed";
      }
      if (failure === "") await this.complete(job);
      else await this.fail(job, failure);
    } catch (error) {
      // The database is unreachable: the lock stays and the job is retried after the visibility timeout.
      this.jobs.report("could not record job result", { id: job.id, name: job.name, error: errorMessage(error) });
    } finally {
      this.running--;
      this.processed++;
      this.wake();
      this.wakeIdle();
    }
  }

  private async complete(job: ClaimedJob): Promise<void> {
    const t = quoteIdent(this.jobs.table);
    await this.jobs.db.execute(
      `update ${t} set status = 'completed', finished_at = now(), locked_at = null, locked_by = null, last_error = null where id = $1::bigint and locked_by = $2`,
      [job.id, this.id],
    );
  }

  private async fail(job: ClaimedJob, message: string): Promise<void> {
    const t = quoteIdent(this.jobs.table);
    const dead = job.attempt >= job.maxAttempts;
    const delay = retryDelay(job.attempt, this.backoff, this.maxBackoff);
    await this.jobs.db.execute(
      `update ${t} set
         status = $3,
         run_at = case when $3 = 'pending' then now() + $4::double precision * interval '1 millisecond' else run_at end,
         finished_at = case when $3 = 'dead' then now() else null end,
         last_error = $5, locked_at = null, locked_by = null
       where id = $1::bigint and locked_by = $2`,
      [job.id, this.id, dead ? "dead" : "pending", delay, message],
    );
    this.jobs.report(dead ? "job dead" : "job failed, retrying", { id: job.id, name: job.name, attempt: job.attempt, error: message });
  }
}
