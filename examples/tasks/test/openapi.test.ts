/** `qala openapi` on this app: the document is stable (snapshot) and YAML output works. No database needed. */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "../../packages/cli/src/bin.ts");

function openapi(out: string, ...flags: string[]): string {
  const run = spawnSync("bun", [CLI, "openapi", "--out", out, ...flags], { cwd: ROOT, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`qala openapi failed:\n${run.stdout}\n${run.stderr}`);
  return readFileSync(out, "utf8");
}

test("qala openapi: the tasks API document", () => {
  const dir = mkdtempSync(join(tmpdir(), "tasks-openapi-"));
  try {
    const json = openapi(join(dir, "openapi.json"));
    expect(JSON.parse(json)).toMatchSnapshot();
    // `generate` wrote the same document for the /openapi.json route (package.json opts in).
    expect(readFileSync(join(ROOT, ".qala/openapi.json"), "utf8")).toBe(json);
    const yaml = openapi(join(dir, "openapi.yaml"), "--yaml");
    expect(yaml.startsWith('openapi: "3.1.0"\ninfo:\n  title: "Tasks API"\n')).toBe(true);
    expect(yaml).toContain('  "/tasks/{id}/complete":\n    post:\n      operationId: "tasks.complete"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
