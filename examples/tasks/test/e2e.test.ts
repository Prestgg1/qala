/**
 * End to end: migrate, build the native binary (no Node.js inside), start it, and drive it over HTTP
 * with the same typed client a frontend uses. `E2E_TARGET=bun` runs the same suite against
 * `bun .qala/main.ts` instead, to show both behave the same.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "@qala/client";
import { Database } from "@qala/core";
import { env } from "../.qala/env.gen";
import { tasksApi } from "../web/client";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "../../packages/cli/src/bin.ts");
const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "e2e-token";
const ON_BUN = process.env["E2E_TARGET"] === "bun";

let server: ChildProcess;

function qala(...args: string[]): string {
  const run = spawnSync("bun", [CLI, ...args], { cwd: ROOT, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`qala ${args.join(" ")} failed:\n${run.stdout}\n${run.stderr}`);
  return run.stdout;
}

async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error(`${url} did not start`);
}

beforeAll(async () => {
  qala("migrate");
  const db = new Database(env.DATABASE_URL);
  await db.execute("truncate tasks cascade");
  db.close();
  const childEnv = { ...process.env, PORT: String(PORT), API_TOKEN: TOKEN, LOG_REQUESTS: "false" };
  if (ON_BUN) {
    qala("generate");
    server = spawn("bun", [".qala/main.ts"], { cwd: ROOT, env: childEnv, stdio: "inherit" });
  } else {
    expect(qala("build")).toContain("dist/app");
    server = spawn(join(ROOT, "dist/app"), [], { cwd: ROOT, env: childEnv, stdio: "inherit" });
  }
  await waitFor(`${BASE}/health`);
}, 120_000);

afterAll(() => {
  server?.kill();
});

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

describe(`tasks API (${ON_BUN ? "bun" : "native binary"})`, () => {
  const api = tasksApi(BASE, TOKEN);
  const anonymous = tasksApi(BASE);

  test("create, read, update, delete", async () => {
    const task = await api.tasks.store({ body: { title: "  Ship   the release ", priority: 1 } });
    expect(task).toMatchObject({ title: "Ship the release", priority: 1, done: false, description: null, dueAt: null });
    expect(task.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(await api.tasks.show({ params: { id: task.id } })).toEqual(task);

    const changed = await api.tasks.update({ params: { id: task.id }, body: { description: "notes", dueAt: "2026-12-01T09:00:00Z" } });
    expect(changed).toMatchObject({ description: "notes", dueAt: "2026-12-01T09:00:00.000Z", title: "Ship the release" });

    expect(await api.tasks.destroy({ params: { id: task.id } })).toBeNull();
    expect((await failure(api.tasks.show({ params: { id: task.id } }))).status).toBe(404);
  });

  test("filters: done, text search, limit", async () => {
    const a = await api.tasks.store({ body: { title: "Alpha report" } });
    await api.tasks.store({ body: { title: "Beta report" } });
    await api.tasks.store({ body: { title: "Gamma notes" } });
    await api.tasks.complete({ params: { id: a.id } });

    const reports = await api.tasks.index({ query: { q: "report" } });
    expect(reports.map((t) => t.title).sort()).toEqual(["Alpha report", "Beta report"]);
    const openReports = await api.tasks.index({ query: { q: "report", done: false } });
    expect(openReports.map((t) => t.title)).toEqual(["Beta report"]);
    expect(await api.tasks.index({ query: { limit: 1 } })).toHaveLength(1);
  });

  test("validation errors list every problem (422)", async () => {
    const error = await failure(api.tasks.store({ body: { title: "", priority: 9 } }));
    expect(error.status).toBe(422);
    expect(error.code).toBe("validation_failed");
    expect(error.details).toEqual([
      { path: "title", message: "must be at least 1 characters" },
      { path: "priority", message: "must be at most 4" },
    ]);
    expect((await failure(api.tasks.show({ params: { id: "not-a-uuid" } }))).details).toEqual([{ path: "id", message: "must be a UUID" }]);
  });

  test("domain rules: blank titles and completing twice (422)", async () => {
    const blank = await failure(api.tasks.store({ body: { title: "   " } }));
    expect([blank.status, blank.code]).toEqual([422, "task_title_blank"]);
    const task = await api.tasks.store({ body: { title: "Complete me" } });
    expect((await api.tasks.complete({ params: { id: task.id } })).done).toBe(true);
    const twice = await failure(api.tasks.complete({ params: { id: task.id } }));
    expect([twice.status, twice.code]).toEqual([422, "task_already_completed"]);
  });

  test("duplicate title is a 409 from the custom error handler", async () => {
    await api.tasks.store({ body: { title: "Unique title" } });
    const error = await failure(api.tasks.store({ body: { title: "Unique title" } }));
    expect([error.status, error.code]).toEqual([409, "conflict"]);
  });

  test("writes need the token (401), reads do not", async () => {
    expect((await failure(anonymous.tasks.store({ body: { title: "Nope" } }))).status).toBe(401);
    expect(Array.isArray(await anonymous.tasks.index())).toBe(true);
  });

  test("comments belong to a task", async () => {
    const task = await api.tasks.store({ body: { title: "Discuss" } });
    const comment = await api.comments.store({ body: { taskId: task.id, author: "ali", body: "First!" } });
    expect(comment).toMatchObject({ taskId: task.id, author: "ali", body: "First!" });
    expect(await api.tasks.comments({ params: { id: task.id } })).toEqual([comment]);
    const orphan = await failure(api.comments.store({ body: { taskId: "00000000-0000-4000-8000-000000000000", author: "x", body: "y" } }));
    expect(orphan.status).toBe(404);
    await api.tasks.destroy({ params: { id: task.id } });
    expect((await failure(api.comments.destroy({ params: { id: comment.id } }))).status).toBe(404);
  });

  test("request ids are echoed, or generated when missing or invalid", async () => {
    const echoed = await fetch(`${BASE}/tasks`, { headers: { "x-request-id": "e2e-req-1" } });
    expect(echoed.headers.get("x-request-id")).toBe("e2e-req-1");
    const generated = await fetch(`${BASE}/nope`, { headers: { "x-request-id": "x".repeat(129) } });
    expect(generated.status).toBe(404);
    expect(generated.headers.get("x-request-id")).toMatch(/^[0-9a-f]{32}$/);
  });

  test("/health and /ready", async () => {
    const health = await fetch(`${BASE}/health`);
    expect([health.status, await health.json()]).toEqual([200, { status: "ok" }]);
    expect(health.headers.get("x-request-id")).toMatch(/^[0-9a-f]{32}$/);
    const ready = await fetch(`${BASE}/ready`);
    expect([ready.status, await ready.json()]).toEqual([200, { status: "ready", checks: { database: "up" } }]);
  });

  test("unknown routes and methods", async () => {
    expect((await fetch(`${BASE}/nope`)).status).toBe(404);
    expect((await fetch(`${BASE}/tasks`, { method: "PUT", headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
  });

  test("serves the generated OpenAPI document at /openapi.json", async () => {
    const res = await fetch(`${BASE}/openapi.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const doc = (await res.json()) as { openapi: string; paths: Record<string, Record<string, unknown>> };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths["/tasks/{id}"] ?? {}).sort()).toEqual(["delete", "get", "patch"]);
    // The route documents the app, not itself; the body is the pre-generated file, byte for byte.
    expect(doc.paths["/openapi.json"]).toBeUndefined();
    expect(doc).toEqual(JSON.parse(readFileSync(join(ROOT, ".qala/openapi.json"), "utf8")));
  });

  // Last: stops the server. The database pool closes and the process exits 0 (in-flight requests and WebSockets
  // during shutdown are covered by packages/core/test/lifecycle.test.ts).
  test("SIGTERM shuts down gracefully", async () => {
    const exited = new Promise<number | null>((resolve) => server.on("exit", (code) => resolve(code)));
    expect(Array.isArray(await api.tasks.index())).toBe(true);
    server.kill("SIGTERM");
    expect(await exited).toBe(0);
    await expect(fetch(`${BASE}/health`)).rejects.toThrow();
  });
});
