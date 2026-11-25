import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, watch } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkArchitecture } from "./check";
import { generate } from "./codegen";
import { DOCS, printViolations } from "./diagnostics";
import { nativeArgs } from "./native";
import { CliError, LAYOUT, color, findBin, formatBytes } from "./util";
import { appDatabaseUrl } from "./database-url";

const CLI_DIR = dirname(new URL(import.meta.url).pathname);

/** `qala dev`: generate, run `.qala/main.ts` with `bun --watch`, regenerate when controllers change. */
export function dev(root: string): Promise<number> {
  generate(root);
  const child = spawn(process.execPath, ["--watch", join(LAYOUT.generated, "main.ts")], { cwd: root, stdio: "inherit" });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const watcher = watch(join(root, LAYOUT.app), { recursive: true }, (_event, file) => {
    if (file === null || !String(file).endsWith(".ts")) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const { written } = generate(root);
        if (written.length > 0) console.log(color.dim(`qala: regenerated ${written.join(", ")}`));
      } catch (error) {
        console.error(color.red(error instanceof Error ? error.message : String(error)));
      }
    }, 80);
  });
  return new Promise((done) => {
    const stop = () => child.kill("SIGTERM");
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    child.on("exit", (code) => {
      watcher.close();
      done(code ?? 0);
    });
  });
}

export type BuildOptions = { out: string; optimization?: string; skipCheck?: boolean; keepIr?: boolean };

/** `qala build`: architecture check, codegen, then scriptc → one native executable without Node. */
export function build(root: string, options: BuildOptions): number {
  if (options.skipCheck !== true) {
    const { violations } = checkArchitecture(root);
    if (violations.length > 0) {
      printViolations(violations, color);
      throw new CliError(`Build stopped: ${violations.length} architecture violation(s) (listed above with file:line). Fix them, re-run qala check, or pass --skip-check.`);
    }
  }
  const { controllers, models, queries, providers, diWarnings } = generate(root);
  if (models.length > 0) console.log(`${color.green("✓")} ${models.length} model decoder${models.length === 1 ? "" : "s"}`);
  if (queries > 0) console.log(`${color.green("✓")} ${queries} compiled quer${queries === 1 ? "y" : "ies"}`);
  if (providers > 0) console.log(`${color.green("✓")} ${providers} injected provider${providers === 1 ? "" : "s"}`);
  for (const w of diWarnings) console.log(`${color.yellow("note")} ${w}`);
  const scriptc = findBin("scriptc", [root, CLI_DIR]);
  if (scriptc === null) throw new CliError("scriptc not found: add it with `bun add -d scriptc` and list it in trustedDependencies (its postinstall fetches the native compiler)");
  const out = resolve(root, options.out);
  mkdirSync(dirname(out), { recursive: true });
  const args = ["build", join(LAYOUT.generated, "main.ts"), "--node-islands=off", "-o", out];
  if (options.optimization !== undefined) args.push("--optimization", options.optimization);
  args.push(...nativeArgs(root));
  console.log(color.dim(`$ scriptc ${args.join(" ")}`));
  const started = Date.now();
  const result = spawnSync(scriptc, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(scriptcFailureHint(result.status));
    return result.status ?? 1;
  }
  // scriptc leaves its LLVM IR (tens of MB) next to the binary; it is only useful for debugging the compiler.
  if (options.keepIr !== true) for (const ir of irFiles(out)) rmSync(ir, { force: true });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const routes = controllers.reduce((n, c) => n + c.actions.length, 0);
  console.log(`${color.green("✓")} ${options.out}  ${formatBytes(statSync(out).size)}  ${routes} routes  ${seconds}s  (native, no Node.js runtime)`);
  return 0;
}

/** What to do when scriptc fails: its own errors (above) name the file; these are the usual causes. */
export function scriptcFailureHint(status: number | null): string {
  return [
    color.red(`✗ scriptc failed (exit ${status ?? "signal"}): the native build stopped. Its errors above name the file and line.`),
    "  Usual causes, in order:",
    "  1. Code outside the native subset: run `qala check --fix` (default imports/exports, async overrides of abstract methods, untyped [] ...).",
    "  2. Union pitfalls (SC2003 and friends): narrow before casting into a union (`if (x === null) ...; x as Row`), annotate factory return types.",
    "  3. Object-literal methods with default parameters: make them class methods.",
    "  4. A package without .d.ts, or `export * from \"pkg\"`: use named imports/exports.",
    "  See what compiles and why not: bunx scriptc coverage .qala/main.ts",
    `  Rules: ${DOCS}/guide/native`,
  ].join("\n");
}

/** The LLVM IR files scriptc writes beside `out` (`main.ll`, and `<name>.ll` for good measure). */
export function irFiles(out: string): string[] {
  const dir = dirname(out);
  const names = new Set(["main.ll", `${basename(out)}.ll`]);
  return [...names].map((n) => join(dir, n)).filter((f) => existsSync(f));
}

/** `qala start`: run the built binary. */
export function start(root: string, out: string): Promise<number> {
  const bin = resolve(root, out);
  if (!existsSync(bin)) throw new CliError(`${out} does not exist yet: run qala build`);
  const child = spawn(bin, [], { cwd: root, stdio: "inherit" });
  return new Promise((done) => child.on("exit", (code) => done(code ?? 0)));
}

type Db = { close(): void };
type CoreDb = {
  Database: new (url: string) => Db;
  migrate: (db: Db, files: { name: string; sql: string }[]) => Promise<string[]>;
};

/** Loads @qala/core as the app resolves it (falls back to the copy next to this CLI, in the monorepo). */
export async function loadCore(root: string): Promise<CoreDb> {
  let entry: string;
  try {
    entry = createRequire(join(root, "package.json")).resolve("@qala/core");
  } catch {
    entry = resolve(CLI_DIR, "../../core/src/index.ts");
    if (!existsSync(entry)) throw new CliError("@qala/core is not installed in this app: bun add @qala/core");
  }
  const core = (await import(pathToFileURL(entry).href)) as Partial<CoreDb>;
  if (typeof core.Database !== "function" || typeof core.migrate !== "function") throw new CliError("This @qala/core has no Database/migrate; update @qala/core");
  return core as CoreDb;
}

/** `qala migrate`: apply database/migrations/*.sql in order (each once). */
export async function migrateCommand(root: string): Promise<number> {
  const dir = join(root, LAYOUT.migrations);
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .sort()
        .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }))
    : [];
  const url = await appDatabaseUrl(root);
  const previous = process.cwd();
  process.chdir(root);
  try {
    const core = await loadCore(root);
    const db = new core.Database(url);
    try {
      const applied = await core.migrate(db, files);
      if (applied.length === 0) console.log(color.dim(`Nothing to migrate (${files.length} migration(s) already applied).`));
      for (const name of applied) console.log(`${color.green("✓")} ${name}`);
    } finally {
      db.close();
    }
  } finally {
    process.chdir(previous);
  }
  return 0;
}
