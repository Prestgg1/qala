import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkArchitecture } from "./check";
import { generate } from "./codegen";
import { CliError, LAYOUT, color, findBin, formatBytes } from "./util";

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

export type BuildOptions = { out: string; optimization?: string; skipCheck?: boolean };

/** `qala build`: architecture check, codegen, then scriptc → one native executable without Node. */
export function build(root: string, options: BuildOptions): number {
  if (options.skipCheck !== true) {
    const { violations } = checkArchitecture(root);
    if (violations.length > 0) {
      for (const v of violations) console.error(`${color.red("✗")} ${v.file}:${v.line}  ${v.message}`);
      throw new CliError(`Build stopped: ${violations.length} architecture violation(s). Fix them or pass --skip-check.`);
    }
  }
  const { controllers, models, queries } = generate(root);
  if (models.length > 0) console.log(`${color.green("✓")} ${models.length} model decoder${models.length === 1 ? "" : "s"}`);
  if (queries > 0) console.log(`${color.green("✓")} ${queries} compiled quer${queries === 1 ? "y" : "ies"}`);
  const scriptc = findBin("scriptc", [root, CLI_DIR]);
  if (scriptc === null) throw new CliError("scriptc not found: add it with `bun add -d scriptc` and list it in trustedDependencies (its postinstall fetches the native compiler)");
  const out = resolve(root, options.out);
  mkdirSync(dirname(out), { recursive: true });
  const args = ["build", join(LAYOUT.generated, "main.ts"), "--node-islands=off", "-o", out];
  if (options.optimization !== undefined) args.push("--optimization", options.optimization);
  console.log(color.dim(`$ scriptc ${args.join(" ")}`));
  const started = Date.now();
  const result = spawnSync(scriptc, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) return result.status ?? 1;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const routes = controllers.reduce((n, c) => n + c.actions.length, 0);
  console.log(`${color.green("✓")} ${options.out}  ${formatBytes(statSync(out).size)}  ${routes} routes  ${seconds}s  (native, no Node.js runtime)`);
  return 0;
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
  const configFile = join(root, LAYOUT.config);
  if (!existsSync(configFile)) throw new CliError(`${LAYOUT.config} is missing; it must export config with databaseUrl`);
  const previous = process.cwd();
  process.chdir(root); // defineConfig reads .env from the working directory
  try {
    const { config } = (await import(pathToFileURL(configFile).href)) as { config?: { databaseUrl?: string } };
    if (config === undefined || typeof config.databaseUrl !== "string") throw new CliError(`${LAYOUT.config} must export \`config\` with a \`databaseUrl\` string`);
    const core = await loadCore(root);
    const db = new core.Database(config.databaseUrl);
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
