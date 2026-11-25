/**
 * Runs test/fixtures/jobs-app.ts under Bun and, with QALA_NATIVE=1, as a scriptc native binary (built with
 * --node-islands=off like `qala build`): enqueue → process → retry → dead, outbox enqueue, stuck-job recovery,
 * LISTEN wakeup and graceful shutdown must behave the same in both.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");
const FIXTURE = join(import.meta.dir, "fixtures/jobs-app.ts");
const URL = process.env.QALA_TEST_DATABASE_URL ?? "postgres://qala:qala@localhost:5432/qala_test";
const NATIVE = process.env["QALA_NATIVE"] === "1";

let nativeDir = "";
let nativeBinary = "";

beforeAll(() => {
  if (!NATIVE) return;
  nativeDir = mkdtempSync(join(tmpdir(), "qala-jobs-"));
  nativeBinary = join(nativeDir, "jobs-app");
  const scriptc = join(ROOT, "node_modules/.bin/scriptc");
  const built = spawnSync(scriptc, ["build", FIXTURE, "--node-islands=off", "-o", nativeBinary], { cwd: ROOT, encoding: "utf8" });
  if (built.status !== 0) throw new Error(`scriptc failed:\n${built.stdout}\n${built.stderr}`);
}, 300_000);

afterAll(() => {
  if (nativeDir !== "") rmSync(nativeDir, { recursive: true, force: true });
});

function run(target: string): { code: number; lines: string[] } {
  const command = target === "native" ? nativeBinary : "bun";
  const args = target === "native" ? [] : [FIXTURE];
  const out = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, DATABASE_URL: URL }, timeout: 30_000 });
  const lines = `${out.stdout}`.split("\n").filter((l) => l !== "");
  if (out.status !== 0) throw new Error(`fixture exited ${out.status}:\n${out.stdout}\n${out.stderr}`);
  return { code: out.status ?? -1, lines };
}

function suite(target: string): void {
  describe(`jobs (${target})`, () => {
    test("enqueue → process → retry → dead, outbox, recovery, LISTEN wakeup, graceful shutdown", () => {
      const { code, lines } = run(target);
      expect(code).toBe(0);
      expect(lines).toContain('invalid: Invalid payload of job "greet"');
      expect(lines).toContain("drained: 1");
      expect(lines).toContain("greet: completed attempts=1 error=");
      expect(lines).toContain("flaky: dead attempts=2 error=boom 1");
      expect(lines).toContain("flaky2: completed attempts=2 error=");
      expect(lines).toContain("rolled back rows: 0");
      expect(lines).toContain("recovered: 1");
      expect(lines).toContain("stuck: pending attempts=1");
      expect(lines).toContain("woken: yes");
      expect(lines).toContain("shutdown: clean active=no");
      expect(lines).toContain("committed: completed attempts=1 error=");
      for (const line of ["inbox: greet ada a+b attempt=1", "inbox: flaky 2 attempt=2", "inbox: greet committed  attempt=1", "inbox: greet stuck  attempt=2", "inbox: slow 200"]) {
        expect(lines).toContain(line);
      }
      expect(lines.filter((l) => l.startsWith("inbox: "))).toHaveLength(5);
      expect(lines[lines.length - 1]).toBe("done");
    }, 30_000);
  });
}

suite("bun");
if (NATIVE) suite("native");
