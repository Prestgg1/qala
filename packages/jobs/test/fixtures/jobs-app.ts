/**
 * A small program for test/native.test.ts: enqueue → process → retry → dead, transactional enqueue, LISTEN wakeup
 * and graceful shutdown through `app.shutdown()`. It runs under Bun and, built with scriptc, as a native binary;
 * it prints one line per check and "done" at the end.
 */
import { Container, createApp, Database, provide, t } from "@qala/core";
import { defineJob, Jobs, jobsTableSql } from "@qala/jobs";

class Inbox {
  readonly lines: string[] = [];
}

let failuresLeft = 0;

const Greet = defineJob("greet", t.object({ name: t.string({ min: 1 }), tags: t.array(t.string()) }), async (payload, job) => {
  job.container.get(Inbox).lines.push(`greet ${payload.name} ${payload.tags.join("+")} attempt=${job.attempt}`);
});

const Flaky = defineJob(
  "flaky",
  t.object({ n: t.number() }),
  async (payload, job) => {
    if (failuresLeft > 0) {
      failuresLeft--;
      throw new Error(`boom ${payload.n}`);
    }
    job.container.get(Inbox).lines.push(`flaky ${payload.n} attempt=${job.attempt}`);
  },
  { maxAttempts: 2 },
);

const Slow = defineJob("slow", t.object({ ms: t.number() }), async (payload, job) => {
  await new Promise<void>((resolve) => setTimeout(resolve, payload.ms));
  job.container.get(Inbox).lines.push(`slow ${payload.ms}`);
});

function wait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function status(db: Database, id: string): Promise<string> {
  const rows = await db.query("select status, attempts, coalesce(last_error, '') as error from qala_jobs where id = $1::bigint", [id]);
  const row = rows[0];
  if (row === undefined) return "missing";
  return `${String(row["status"])} attempts=${String(row["attempts"])} error=${String(row["error"])}`;
}

async function main(): Promise<void> {
  const db = new Database(process.env["DATABASE_URL"] ?? "postgres://qala:qala@localhost:5432/qala_test");
  await db.execute("drop table if exists qala_jobs");
  for (const statement of jobsTableSql().split(";")) {
    if (statement.replace(/--.*/g, "").trim() !== "") await db.execute(statement, []);
  }
  const inbox = new Inbox();
  const jobs = new Jobs(db, [Greet, Flaky, Slow], { container: new Container([provide(Inbox, () => inbox)]) });

  // enqueue → process
  const greet = await jobs.enqueue(Greet, { name: "ada", tags: ["a", "b"] });
  let invalid = "accepted";
  try {
    await jobs.enqueue(Greet, { name: "", tags: [] });
  } catch (error) {
    invalid = error instanceof Error ? error.message : "error";
  }
  console.log(`invalid: ${invalid}`);
  console.log(`drained: ${await jobs.drain({ backoff: 0 })}`);
  console.log(`greet: ${await status(db, greet)}`);

  // retry → dead
  failuresLeft = 5;
  const dead = await jobs.enqueue(Flaky, { n: 1 });
  const worker = jobs.work({ backoff: 0 });
  await worker.drain();
  console.log(`flaky: ${await status(db, dead)}`);

  // retry → success
  failuresLeft = 1;
  const retried = await jobs.enqueue(Flaky, { n: 2 });
  await worker.drain();
  console.log(`flaky2: ${await status(db, retried)}`);

  // outbox: only committed jobs exist
  try {
    await db.transaction(async (tx) => {
      await jobs.enqueue(Greet, { name: "rolled-back", tags: [] }, { tx });
      throw new Error("abort");
    });
  } catch {}
  const committed = await db.transaction(async (tx) => jobs.enqueue(Greet, { name: "committed", tags: [] }, { tx, delay: 0 }));
  const rows = await db.query("select count(*)::int as n from qala_jobs where payload->>'name' = 'rolled-back'", []);
  console.log(`rolled back rows: ${String(rows[0]?.["n"])}`);

  // stuck-job recovery
  const stuck = await db.query(
    "insert into qala_jobs (name, payload, status, attempts, locked_at, locked_by) values ('greet', '{\"name\":\"stuck\",\"tags\":[]}', 'running', 1, now() - interval '1 hour', 'gone') returning id::text as id",
    [],
  );
  const stuckId = String(stuck[0]?.["id"]);
  console.log(`recovered: ${await jobs.work({ visibilityTimeout: 60_000 }).recover()}`);
  console.log(`stuck: ${(await status(db, stuckId)).split(" error=")[0]}`);

  // a started worker: LISTEN wakes it (poll interval is a minute), app.shutdown waits for the running job
  const app = createApp({ controllers: [], providers: [provide(Inbox, () => inbox)] });
  const live = jobs.start(app, { pollInterval: 60_000, concurrency: 2, shutdownTimeout: 3000 });
  await wait(300);
  const started = Date.now();
  await jobs.enqueue(Slow, { ms: 200 });
  for (let i = 0; i < 100 && live.running === 0; i++) await wait(10);
  console.log(`woken: ${Date.now() - started < 1500 ? "yes" : "no"}`);
  const drained = await app.shutdown(1000);
  console.log(`shutdown: ${drained ? "clean" : "timeout"} active=${live.active ? "yes" : "no"}`);
  console.log(`committed: ${await status(db, committed)}`);
  for (const line of inbox.lines) console.log(`inbox: ${line}`);
  console.log("done");
  db.close();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
