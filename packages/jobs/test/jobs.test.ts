import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Container, createApp, Database, provide, t, ValidationError } from "@qala/core";
import { defineJob, Jobs, jobsTableSql, retryDelay, type JobPayload } from "@qala/jobs";

const URL = process.env.QALA_TEST_DATABASE_URL ?? "postgres://qala:qala@localhost:5432/qala_test";
const db = new Database(URL, { max: 8 });

class Inbox {
  readonly lines: string[] = [];
}

const inbox = new Inbox();
let failuresLeft = 0;

const Greet = defineJob("greet", t.object({ name: t.string({ min: 1 }) }), async (payload, job) => {
  job.container.get(Inbox).lines.push(`hello ${payload.name} (attempt ${job.attempt}/${job.maxAttempts})`);
});

const Flaky = defineJob(
  "flaky",
  t.object({ n: t.number() }),
  async (payload) => {
    if (failuresLeft > 0) {
      failuresLeft--;
      throw new Error(`boom ${payload.n}`);
    }
    inbox.lines.push(`flaky ${payload.n}`);
  },
  { maxAttempts: 3, queue: "flaky" },
);

const Slow = defineJob("slow", t.object({ ms: t.number() }), async (payload) => {
  await Bun.sleep(payload.ms);
  inbox.lines.push(`slow ${payload.ms}`);
});

const container = new Container([provide(Inbox, () => inbox)]);
const jobs = new Jobs(db, [Greet, Flaky, Slow], { container });
// Keep test output quiet: failures are expected here.
jobs.report = () => {};

type Row = { status: string; attempts: number; max_attempts: number; last_error: string | null; queue: string; payload: string; delay: number };

async function row(id: string): Promise<Row> {
  const rows = await db.query(
    "select status, attempts, max_attempts, last_error, queue, payload::text as payload, extract(epoch from run_at - now()) * 1000 as delay from qala_jobs where id = $1::bigint",
    [id],
  );
  return rows[0] as unknown as Row;
}

beforeAll(async () => {
  await db.execute("drop table if exists qala_jobs");
  for (const statement of jobsTableSql().split(";")) if (statement.replace(/--.*$/gm, "").trim() !== "") await db.execute(statement);
});

beforeEach(async () => {
  await db.execute("delete from qala_jobs");
  inbox.lines.length = 0;
  failuresLeft = 0;
});

afterAll(async () => {
  await db.execute("drop table if exists qala_jobs");
  db.close();
});

describe("enqueue", () => {
  test("stores a validated job with the job's defaults", async () => {
    const id = await jobs.enqueue(Greet, { name: "Ada" });
    expect(id).toMatch(/^\d+$/);
    const r = await row(id);
    expect(r.status).toBe("pending");
    expect(r.queue).toBe("default");
    expect(r.max_attempts).toBe(5);
    expect(JSON.parse(r.payload)).toEqual({ name: "Ada" });
    const payload: JobPayload<typeof Greet> = { name: "typed" };
    expect(payload.name).toBe("typed");
  });

  test("rejects an invalid payload", async () => {
    await expect(jobs.enqueue(Greet, { name: "" })).rejects.toBeInstanceOf(ValidationError);
    expect(await db.query("select id from qala_jobs")).toHaveLength(0);
  });

  test("options: queue, maxAttempts, delay", async () => {
    const id = await jobs.enqueue(Greet, { name: "later" }, { queue: "mail", maxAttempts: 9, delay: 60_000 });
    const r = await row(id);
    expect(r.queue).toBe("mail");
    expect(r.max_attempts).toBe(9);
    expect(Number(r.delay)).toBeGreaterThan(55_000);
    expect(await jobs.drain()).toBe(0);
  });

  test("inside a transaction: only committed jobs exist", async () => {
    await expect(
      db.transaction(async (tx) => {
        await jobs.enqueue(Greet, { name: "rolled back" }, { tx });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await db.query("select id from qala_jobs")).toHaveLength(0);
    const id = await db.transaction(async (tx) => jobs.enqueue(Greet, { name: "committed" }, { tx }));
    expect((await row(id)).status).toBe("pending");
  });
});

describe("processing", () => {
  test("drain runs due jobs with the container and marks them completed", async () => {
    const a = await jobs.enqueue(Greet, { name: "a" });
    await jobs.enqueue(Greet, { name: "b" });
    expect(await jobs.drain()).toBe(2);
    expect(inbox.lines).toEqual(["hello a (attempt 1/5)", "hello b (attempt 1/5)"]);
    const rows = await db.query("select status, finished_at is not null as finished, locked_by from qala_jobs where id = $1::bigint", [a]);
    expect(rows[0]).toEqual({ status: "completed", finished: true, locked_by: null });
  });

  test("failures retry with exponential backoff, then the job is dead", async () => {
    failuresLeft = 10;
    const id = await jobs.enqueue(Flaky, { n: 1 });
    const worker = jobs.work({ backoff: 1000 });
    expect(await worker.drain()).toBe(1);
    let r = await row(id);
    expect(r.status).toBe("pending");
    expect(r.attempts).toBe(1);
    expect(r.last_error).toBe("boom 1");
    expect(Number(r.delay)).toBeGreaterThan(800);
    expect(Number(r.delay)).toBeLessThan(1100);
    // Make it due again and fail twice more: the second retry waits 2 s; after max_attempts (3) it is dead.
    await db.execute("update qala_jobs set run_at = now()");
    await worker.drain();
    r = await row(id);
    expect(r.attempts).toBe(2);
    expect(Number(r.delay)).toBeGreaterThan(1800);
    await db.execute("update qala_jobs set run_at = now()");
    await worker.drain();
    r = await row(id);
    expect(r.status).toBe("dead");
    expect(r.attempts).toBe(3);
    expect(r.last_error).toBe("boom 1");
    expect(inbox.lines).toEqual([]);
    // A dead job can be retried by hand.
    failuresLeft = 0;
    expect(await jobs.retry(id)).toBe(true);
    await worker.drain();
    expect((await row(id)).status).toBe("completed");
    expect(inbox.lines).toEqual(["flaky 1"]);
  });

  test("a job that succeeds on a retry completes", async () => {
    failuresLeft = 1;
    const id = await jobs.enqueue(Flaky, { n: 2 });
    const worker = jobs.work({ backoff: 0 });
    await worker.drain();
    expect((await row(id)).status).toBe("completed");
    expect(inbox.lines).toEqual(["flaky 2"]);
  });

  test("unknown jobs and invalid stored payloads fail like errors", async () => {
    await db.execute("insert into qala_jobs (name, payload, max_attempts) values ('nope', '{}', 1), ('greet', '{\"name\": 5}', 1)");
    await jobs.drain();
    const rows = await db.query("select name, status, last_error from qala_jobs order by id");
    expect(rows.map((r) => r["status"])).toEqual(["dead", "dead"]);
    expect(String(rows[0]!["last_error"])).toContain('unknown job "nope"');
    expect(String(rows[1]!["last_error"])).toContain("payload of job");
  });

  test("queues: a worker only takes its queues", async () => {
    await jobs.enqueue(Greet, { name: "default queue" });
    await jobs.enqueue(Flaky, { n: 3 });
    expect(await jobs.drain({ queues: ["flaky"] })).toBe(1);
    expect(inbox.lines).toEqual(["flaky 3"]);
  });

  test("stuck jobs come back after the visibility timeout, or die on their last attempt", async () => {
    await db.execute(
      "insert into qala_jobs (name, payload, status, attempts, max_attempts, locked_at, locked_by) values ('greet', '{\"name\":\"stuck\"}', 'running', 1, 5, now() - interval '10 minutes', 'gone'), ('greet', '{\"name\":\"last\"}', 'running', 5, 5, now() - interval '10 minutes', 'gone'), ('greet', '{\"name\":\"fresh\"}', 'running', 1, 5, now(), 'alive')",
    );
    const worker = jobs.work({ visibilityTimeout: 60_000 });
    expect(await worker.recover()).toBe(2);
    const rows = await db.query("select payload->>'name' as name, status, last_error from qala_jobs order by id");
    expect(rows.map((r) => `${r["name"]} ${r["status"]}`)).toEqual(["stuck pending", "last dead", "fresh running"]);
    expect(String(rows[0]!["last_error"])).toContain("visibility timeout");
    await worker.drain();
    expect(inbox.lines).toEqual(["hello stuck (attempt 2/5)"]);
  });
});

describe("workers", () => {
  test("LISTEN/NOTIFY wakes an idle worker long before its next poll", async () => {
    const worker = jobs.work({ pollInterval: 60_000 });
    worker.start();
    await Bun.sleep(150); // listening
    const started = Date.now();
    await jobs.enqueue(Greet, { name: "now" });
    for (let i = 0; i < 100 && inbox.lines.length === 0; i++) await Bun.sleep(20);
    expect(inbox.lines).toEqual(["hello now (attempt 1/5)"]);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(await worker.stop(1000)).toBe(true);
  });

  test("concurrency and SKIP LOCKED: two workers run every job exactly once", async () => {
    for (let i = 0; i < 20; i++) await jobs.enqueue(Slow, { ms: 20 + (i % 3) * 10 });
    const a = jobs.work({ concurrency: 4, pollInterval: 50 });
    const b = jobs.work({ concurrency: 4, pollInterval: 50 });
    let peak = 0;
    a.start();
    b.start();
    for (let i = 0; i < 200 && inbox.lines.length < 20; i++) {
      peak = Math.max(peak, a.running);
      await Bun.sleep(5);
    }
    await Promise.all([a.stop(1000), b.stop(1000)]);
    expect(inbox.lines).toHaveLength(20);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(a.processed + b.processed).toBe(20);
    expect(a.processed).toBeGreaterThan(0);
    expect(b.processed).toBeGreaterThan(0);
    const counts = await db.query("select status, count(*)::int as n, max(attempts) as attempts from qala_jobs group by status");
    expect(counts).toEqual([{ status: "completed", n: 20, attempts: 1 }]);
  });

  test("polling picks up delayed jobs", async () => {
    const worker = jobs.work({ pollInterval: 50, listen: false });
    worker.start();
    await jobs.enqueue(Greet, { name: "delayed" }, { delay: 200 });
    await Bun.sleep(100);
    expect(inbox.lines).toEqual([]);
    for (let i = 0; i < 50 && inbox.lines.length === 0; i++) await Bun.sleep(20);
    expect(inbox.lines).toEqual(["hello delayed (attempt 1/5)"]);
    await worker.stop(1000);
  });

  test("jobs.start(app): app.shutdown stops claiming and waits for running jobs", async () => {
    const app = createApp({ controllers: [], providers: [provide(Inbox, () => inbox)] });
    const own = new Jobs(db, [Greet, Slow]);
    own.report = () => {};
    const worker = own.start(app, { pollInterval: 50, shutdownTimeout: 2000 });
    expect(worker.active).toBe(true);
    await own.enqueue(Slow, { ms: 300 });
    for (let i = 0; i < 50 && worker.running === 0; i++) await Bun.sleep(10);
    expect(worker.running).toBe(1);
    const done = app.shutdown(1000);
    await Bun.sleep(20);
    await own.enqueue(Greet, { name: "after shutdown" });
    expect(await done).toBe(true);
    expect(worker.active).toBe(false);
    expect(inbox.lines).toEqual(["slow 300"]);
    const pending = await db.query("select name from qala_jobs where status = 'pending'");
    expect(pending).toEqual([{ name: "greet" }]);
  });

  test("stop gives up after its timeout and leaves the job locked", async () => {
    const worker = jobs.work({ pollInterval: 50 });
    worker.start();
    await jobs.enqueue(Slow, { ms: 400 });
    for (let i = 0; i < 50 && worker.running === 0; i++) await Bun.sleep(10);
    expect(await worker.stop(50)).toBe(false);
    expect((await db.query("select status from qala_jobs"))[0]).toEqual({ status: "running" });
    for (let i = 0; i < 50 && worker.running > 0; i++) await Bun.sleep(20);
  });
});

describe("helpers", () => {
  test("retryDelay doubles and is capped", () => {
    expect([1, 2, 3, 4].map((n) => retryDelay(n, 1000, 5000))).toEqual([1000, 2000, 4000, 5000]);
    expect(retryDelay(500, 1000, 3_600_000)).toBe(3_600_000);
  });

  test("prune deletes old completed jobs", async () => {
    await jobs.enqueue(Greet, { name: "x" });
    await jobs.drain();
    expect(await jobs.prune(60_000)).toBe(0);
    await db.execute("update qala_jobs set finished_at = now() - interval '2 days'");
    expect(await jobs.prune()).toBe(1);
  });
});
