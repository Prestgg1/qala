import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { appDatabaseUrl } from "./database-url";
import { color, findBin, findRoot, LAYOUT } from "./util";

export type CheckStatus = "ok" | "warn" | "fail";
export type CheckResult = { name: string; status: CheckStatus; detail: string; hint?: string };

const CLI_DIR = dirname(new URL(import.meta.url).pathname);

/** Compares dotted versions numerically: 1.10.0 > 1.9.3. Pre-release suffixes are ignored. */
export function versionAtLeast(actual: string, min: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split("-")[0]!.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const a = parse(actual);
  const b = parse(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export function checkRuntime(bunVersion: string | undefined, nodeVersion: string | undefined, platform: string): CheckResult[] {
  const out: CheckResult[] = [];
  out.push(
    bunVersion === undefined
      ? { name: "Bun", status: "fail", detail: "not running under Bun", hint: "install Bun ≥ 1.3: https://bun.sh" }
      : versionAtLeast(bunVersion, "1.3.0")
        ? { name: "Bun", status: "ok", detail: bunVersion }
        : { name: "Bun", status: "fail", detail: `${bunVersion} (need ≥ 1.3)`, hint: "bun upgrade" },
  );
  out.push(
    nodeVersion === undefined
      ? { name: "Node.js", status: "warn", detail: "not found", hint: "Node.js ≥ 24 is only needed to install scriptc" }
      : versionAtLeast(nodeVersion, "24.0.0")
        ? { name: "Node.js", status: "ok", detail: nodeVersion }
        : { name: "Node.js", status: "warn", detail: `${nodeVersion} (scriptc install wants ≥ 24)` },
  );
  out.push(
    platform === "linux" || platform === "darwin"
      ? { name: "Platform", status: "ok", detail: platform }
      : { name: "Platform", status: "fail", detail: `${platform} is not supported`, hint: "use Linux or macOS (WSL works on Windows)" },
  );
  return out;
}

function nodeVersion(): string | undefined {
  try {
    const r = Bun.spawnSync(["node", "--version"]);
    return r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
  } catch {
    return undefined;
  }
}

function scriptcCheck(root: string | null): CheckResult {
  const bin = findBin("scriptc", root === null ? [CLI_DIR] : [root, CLI_DIR]);
  if (bin === null) return { name: "scriptc", status: "fail", detail: "not found", hint: "bun add -d scriptc and list it in trustedDependencies" };
  const pkg = join(dirname(dirname(bin)), "scriptc", "package.json");
  let version = "unknown version";
  try {
    version = (JSON.parse(readFileSync(pkg, "utf8")) as { version?: string }).version ?? version;
  } catch {}
  return { name: "scriptc", status: "ok", detail: version };
}

function tcpReachable(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function databaseCheck(root: string): Promise<CheckResult> {
  let url: string;
  try {
    url = await appDatabaseUrl(root);
  } catch {
    return { name: "Database", status: "warn", detail: "no DATABASE_URL configured" };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { name: "Database", status: "fail", detail: "DATABASE_URL is not a valid URL" };
  }
  const host = parsed.hostname || "localhost";
  const port = Number(parsed.port || 5432);
  return (await tcpReachable(host, port))
    ? { name: "Database", status: "ok", detail: `${host}:${port} reachable` }
    : { name: "Database", status: "fail", detail: `${host}:${port} unreachable`, hint: "is PostgreSQL running?" };
}

export async function runDoctor(): Promise<CheckResult[]> {
  const results = checkRuntime(typeof Bun === "undefined" ? undefined : Bun.version, nodeVersion(), process.platform);
  let root: string | null = null;
  try {
    root = findRoot();
  } catch {}
  results.push(scriptcCheck(root));
  if (root === null) {
    results.push({ name: "Project", status: "warn", detail: "not inside a Qala app (app checks skipped)" });
    return results;
  }
  results.push({ name: "Project", status: "ok", detail: root });
  results.push(
    existsSync(join(root, LAYOUT.generated, "main.ts"))
      ? { name: "Generated code", status: "ok", detail: `${LAYOUT.generated}/ present` }
      : { name: "Generated code", status: "warn", detail: "missing", hint: "qala generate" },
  );
  results.push(await databaseCheck(root));
  return results;
}

export async function doctorCommand(): Promise<number> {
  const results = await runDoctor();
  const icon = { ok: color.green("✓"), warn: color.yellow("!"), fail: color.red("✗") };
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    console.log(`${icon[r.status]} ${r.name.padEnd(width)}  ${r.detail}`);
    if (r.hint !== undefined && r.status !== "ok") console.log(color.dim(`  ${" ".repeat(width)}  → ${r.hint}`));
  }
  return results.some((r) => r.status === "fail") ? 1 : 0;
}
