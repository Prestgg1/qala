/**
 * Native binary vs `bun .qala/main.ts`, same code, same database.
 *   bun bench/run.ts [--seconds 10] [--concurrency 50] [--speed] [--json out.json] [--check]
 * --json writes the results for CI artifacts; --check exits 1 when the two servers answer differently or the
 * native binary is clearly slower than Bun (below 80% of Bun's req/s) in any scenario.
 * Servers run on cores 0-2, the load generator (oha) on core 3. Needs `oha` and `taskset`.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "@qala/core";
import { env } from "../.qala/env.gen";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "../../packages/cli/src/bin.ts");
const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const SECONDS = arg("seconds", 10);
const CONCURRENCY = arg("concurrency", 50);
const TOKEN = "bench-token";

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function rssMb(pid: number): number {
  const out = run("ps", ["-o", "rss=", "--ppid", String(pid), "-p", String(pid)]);
  return Math.round(out.split("\n").reduce((s, l) => s + (Number(l.trim()) || 0), 0) / 1024);
}

async function waitFor(url: string): Promise<number> {
  const started = performance.now();
  for (;;) {
    try {
      if ((await fetch(url)).ok) return Math.round(performance.now() - started);
    } catch {}
    if (performance.now() - started > 20_000) throw new Error(`${url} did not start`);
    await Bun.sleep(5);
  }
}

// Data: 1000 tasks, one task to comment on.
const db = new Database(env.DATABASE_URL);
run("bun", [CLI, "migrate"]);
await db.execute("truncate tasks cascade");
await db.execute("insert into tasks (title, description, priority, done) select 'Task number ' || i, 'Description of task ' || i, 1 + i % 4, i % 3 = 0 from generate_series(1, 1000) i");
const ids = (await db.query("select id from tasks order by random() limit 200")).map((r) => String(r["id"]));
db.close();
const target = ids[0]!;
writeFileSync("/tmp/qala-bench-ids.txt", "");

const SPEED = process.argv.includes("--speed");
run("bun", [CLI, "build", ...(SPEED ? ["--optimization", "speed"] : [])]);

type Scenario = { name: string; args: (base: string) => string[] };
const scenarios: Scenario[] = [
  { name: "GET /tasks?limit=50", args: (b) => [`${b}/tasks?limit=50`] },
  { name: "GET /tasks/:id", args: (b) => { writeFileSync("/tmp/qala-bench-ids.txt", ids.map((id) => `${b}/tasks/${id}`).join("\n") + "\n"); return ["--urls-from-file", "/tmp/qala-bench-ids.txt"]; } },
  { name: "GET /tasks?q=number 12", args: (b) => [`${b}/tasks?q=number%2012&limit=20`] },
  { name: "POST /comments", args: (b) => ["-m", "POST", "-H", "content-type: application/json", "-H", `authorization: Bearer ${TOKEN}`, "-d", JSON.stringify({ taskId: target, author: "bench", body: "A benchmark comment" }), `${b}/comments`] },
];

type Row = { target: string; scenario: string; rps: number; p50: number; p99: number; codes: string; rss: number };
const rows: Row[] = [];
const servers: { name: string; startup: number; idle: number; peak: number }[] = [];

async function measure(name: string, cmd: string[], port: number): Promise<void> {
  const proc: ChildProcess = spawn("taskset", ["-c", "0-2", ...cmd], { cwd: ROOT, env: { ...process.env, PORT: String(port), API_TOKEN: TOKEN, LOG_REQUESTS: "false" }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  const startup = await waitFor(`${base}/health`);
  await fetch(`${base}/tasks?limit=1`);
  const pid = proc.pid!;
  const idle = rssMb(pid);
  let peak = idle;
  for (const s of scenarios) {
    run("taskset", ["-c", "3", "oha", "-z", "3s", "-c", String(CONCURRENCY), "--no-tui", "--output-format", "quiet", ...s.args(base)]);
    const out = JSON.parse(run("taskset", ["-c", "3", "oha", "-z", `${SECONDS}s`, "-c", String(CONCURRENCY), "--no-tui", "--output-format", "json", ...s.args(base)])) as {
      summary: { requestsPerSec: number };
      latencyPercentiles: Record<string, number>;
      statusCodeDistribution: Record<string, number>;
    };
    const rss = rssMb(pid);
    peak = Math.max(peak, rss);
    rows.push({
      target: name,
      scenario: s.name,
      rps: Math.round(out.summary.requestsPerSec),
      p50: out.latencyPercentiles["p50"]! * 1000,
      p99: out.latencyPercentiles["p99"]! * 1000,
      codes: Object.entries(out.statusCodeDistribution).map(([c, n]) => `${c}×${n}`).join(" "),
      rss,
    });
  }
  servers.push({ name, startup, idle, peak });
  proc.kill();
  await new Promise((r) => proc.once("exit", r));
}

const different: string[] = [];

// Same answers first: both servers on the same data, byte for byte.
{
  const a = spawn(join(ROOT, "dist/app"), [], { cwd: ROOT, env: { ...process.env, PORT: "4801", LOG_REQUESTS: "false" }, stdio: "ignore" });
  const b = spawn("bun", [".qala/main.ts"], { cwd: ROOT, env: { ...process.env, PORT: "4802", LOG_REQUESTS: "false" }, stdio: "ignore" });
  await waitFor("http://127.0.0.1:4801/health");
  await waitFor("http://127.0.0.1:4802/health");
  for (const path of ["/tasks?limit=50", `/tasks/${target}`, "/tasks?q=number%2012", "/tasks/nope", "/tasks?limit=0"]) {
    const [x, y] = await Promise.all([fetch(`http://127.0.0.1:4801${path}`).then((r) => r.text()), fetch(`http://127.0.0.1:4802${path}`).then((r) => r.text())]);
    console.log(`${x === y ? "same" : "DIFFERENT"}  ${path}  (${x.length} bytes)`);
    if (x !== y) different.push(path);
  }
  a.kill();
  b.kill();
}

await measure("native", ["./dist/app"], 4811);
await measure("bun", ["bun", ".qala/main.ts"], 4812);

const load = run("cat", ["/proc/loadavg"]).trim();
console.log(`\n${new Date().toISOString()}  ${run("nproc", []).trim()} cores  load ${load}  ${SECONDS}s per scenario, ${CONCURRENCY} connections, native built with --optimization ${SPEED ? "speed" : "release"}\n`);
console.log("| | startup | idle RSS | peak RSS |\n|---|---|---|---|");
for (const s of servers) console.log(`| ${s.name} | ${s.startup} ms | ${s.idle} MB | ${s.peak} MB |`);
console.log("\n| scenario | target | req/s | p50 | p99 | status codes |\n|---|---|---|---|---|---|");
for (const s of scenarios) {
  for (const r of rows.filter((x) => x.scenario === s.name)) console.log(`| ${r.scenario} | ${r.target} | ${r.rps} | ${r.p50.toFixed(2)} ms | ${r.p99.toFixed(2)} ms | ${r.codes} |`);
}

const jsonIndex = process.argv.indexOf("--json");
if (jsonIndex !== -1) {
  writeFileSync(process.argv[jsonIndex + 1]!, JSON.stringify({ date: new Date().toISOString(), seconds: SECONDS, concurrency: CONCURRENCY, speed: SPEED, servers, rows, different }, null, 2));
}

if (process.argv.includes("--check")) {
  const problems = different.map((p) => `responses differ for ${p}`);
  for (const s of scenarios) {
    const native = rows.find((r) => r.scenario === s.name && r.target === "native");
    const bun = rows.find((r) => r.scenario === s.name && r.target === "bun");
    if (native !== undefined && bun !== undefined && native.rps < bun.rps * 0.8) problems.push(`${s.name}: native ${native.rps} req/s < 80% of Bun's ${bun.rps}`);
  }
  for (const p of problems) console.error(`✗ ${p}`);
  if (problems.length > 0) process.exit(1);
  console.log("✓ native matches Bun byte for byte and is not slower");
}
