#!/usr/bin/env bun
import { checkArchitecture } from "./check";
import { generate } from "./codegen";
import { doctorCommand } from "./doctor";
import { fixApp } from "./fix";
import type { SkippedModel } from "./models";
import { makeController, makeMiddleware, makeMigration, makeModel, makeRepository, makeService, makeTest, type MakeResult } from "./make";
import { pullCommand } from "./pull";
import { build, dev, migrateCommand, rollbackCommand, start, statusCommand } from "./run";
import { migrateMakeCommand } from "./migrate-make";
import { routeTable, scanControllers } from "./scan";
import { scaffold } from "./scaffold";
import { CliError, color, findRoot } from "./util";

const HELP = `${color.bold("qala")} — the Qala builder

${color.bold("Usage")}  qala <command> [options]

${color.bold("Develop")}
  dev                         generate routes, run with Bun, reload on changes
  generate                    write .qala/routes.gen.ts, api.ts, models.gen.ts, main.ts
  routes                      list every route (METHOD PATH controller.action)
  check [--fix]               enforce the Clean Architecture dependency rule; --fix rewrites scriptc pitfalls first
  migrate [--lock-timeout 5s] [--statement-timeout 5min]
                              apply pending database/migrations/*.sql (under an advisory lock)
  migrate:rollback [--steps N]  undo the last N (default 1) migrations with their -- migrate:down sections
  migrate:status              list migrations: applied or pending
  migrate:make <name> [--print]  write the SQL that makes the database match the models
  db:pull [--schema public] [--tables a,b] [--out app/domain/schema] [--url postgres://...] [--force]
                              generate models from an existing PostgreSQL database

${color.bold("Ship")}
  build [--out dist/app] [--optimization release|speed] [--skip-check] [--keep-ir]
                              check + generate + scriptc: one native binary, no Node.js
  start [--out dist/app]      run the built binary

${color.bold("Scaffold")}
  new <dir> [--core <path>]   create a new app (--core: @qala/core src/index.ts, relative to the current directory)
  make:controller <name> [--resource]
  make:model <name>           domain model (table + typed row)
  make:repository <name>      domain contract + Postgres implementation, registered in providers
  make:service <name>         application service, registered in providers
  make:middleware <name>
  make:migration <name>
  (make:* accept --force to overwrite)

  doctor                      check Bun, Node.js, scriptc, clang, project files and database
  help                        this text
`;

type Args = { positional: string[]; flags: Map<string, string | true> };

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") && VALUE_FLAGS.has(arg.slice(2))) flags.set(arg.slice(2), argv[++i]!);
    else flags.set(arg.slice(2), true);
  }
  return { positional, flags };
}

const VALUE_FLAGS = new Set(["out", "optimization", "core", "schema", "tables", "url", "steps", "lock-timeout", "statement-timeout"]);

function flag(args: Args, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function printMake(result: MakeResult): void {
  for (const f of result.created) console.log(`${color.green("created")} ${f}`);
  for (const n of result.notes) console.log(color.dim(`  ${n}`));
}

function printModels(count: number, skipped: SkippedModel[]): void {
  if (count > 0) console.log(`${color.green("✓")} ${count} model decoder${count === 1 ? "" : "s"}`);
  for (const m of skipped) console.log(color.yellow(`note: ${m.relFile}:${m.line} model ${m.exportName} uses the generic decoder: ${m.reason}`));
}

function printRoutes(root: string): void {
  const rows = routeTable(scanControllers(root));
  if (rows.length === 0) {
    console.log(color.dim("No routes yet: qala make:controller <name> --resource"));
    return;
  }
  const width = Math.max(...rows.map((r) => r.path.length));
  const methodColor: Record<string, (s: string) => string> = { GET: color.green, POST: color.yellow, PUT: color.blue, PATCH: color.cyan, DELETE: color.red };
  for (const r of rows) {
    const m = (methodColor[r.method] ?? ((s: string) => s))(r.method.padEnd(6));
    console.log(`${m} ${r.path.padEnd(width)}  ${color.bold(`${r.controller}.${r.action}`)}  ${color.dim(r.file)}`);
  }
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const [command = "help", name] = args.positional;
  const force = args.flags.get("force") === true;
  const needName = (what: string): string => {
    if (name === undefined) throw new CliError(`${command} needs a name, e.g. qala ${command} ${what}`);
    return name;
  };
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    case "new": {
      const dir = needName("my-app");
      const files = scaffold(dir, { corePath: flag(args, "core"), force });
      for (const f of files) console.log(`${color.green("created")} ${dir}/${f}`);
      console.log(`\nNext:\n  cd ${dir}\n  bun install\n  bun run dev`);
      return 0;
    }
    case "generate": {
      const root = findRoot();
      const { written, models, skippedModels, queries, providers, diWarnings } = generate(root);
      for (const f of written) console.log(`${color.green("wrote")} ${f}`);
      printModels(models.length, skippedModels);
      if (queries > 0) console.log(`${color.green("✓")} ${queries} compiled quer${queries === 1 ? "y" : "ies"}`);
      if (providers > 0) console.log(`${color.green("✓")} ${providers} injected provider${providers === 1 ? "" : "s"}`);
      for (const w of diWarnings) console.log(`${color.yellow("note")} ${w}`);
      printRoutes(root);
      return 0;
    }
    case "doctor":
      return doctorCommand();
    case "routes":
      printRoutes(findRoot());
      return 0;
    case "check": {
      const root = findRoot();
      if (args.flags.get("fix") === true) {
        const report = fixApp(root);
        for (const f of report.fixes) console.log(`${color.green("fixed")} ${f.file}:${f.line}  ${f.message}`);
        for (const f of report.unfixable) console.log(color.yellow(`note: ${f.file}:${f.line}  ${f.message}`));
        if (report.fixes.length > 0) console.log(color.dim(`${report.fixes.length} fix(es) in ${report.files.length} file(s)`));
      }
      const { files, violations } = checkArchitecture(root);
      for (const v of violations) console.error(`${color.red("✗")} ${v.file}:${v.line}  ${v.message}`);
      if (violations.length > 0) {
        console.error(color.red(`\n${violations.length} architecture violation(s) in ${files} files.`));
        return 1;
      }
      console.log(`${color.green("✓")} ${files} files follow the dependency rule (domain ← application ← infrastructure/http).`);
      return 0;
    }
    case "dev":
      return dev(findRoot());
    case "build":
      return build(findRoot(), { out: flag(args, "out") ?? "dist/app", optimization: flag(args, "optimization"), skipCheck: args.flags.get("skip-check") === true, keepIr: args.flags.get("keep-ir") === true });
    case "start":
      return start(findRoot(), flag(args, "out") ?? "dist/app");
    case "migrate":
      return migrateCommand(findRoot(), { lockTimeout: flag(args, "lock-timeout"), statementTimeout: flag(args, "statement-timeout") });
    case "migrate:rollback":
      return rollbackCommand(findRoot(), Number(flag(args, "steps") ?? "1"), { lockTimeout: flag(args, "lock-timeout"), statementTimeout: flag(args, "statement-timeout") });
    case "migrate:status":
      return statusCommand(findRoot());
    case "migrate:make":
      return migrateMakeCommand(findRoot(), needName("add_due_dates"), { print: args.flags.get("print") === true });
    case "db:pull": {
      let root: string;
      try {
        root = findRoot();
      } catch (error) {
        if (flag(args, "url") === undefined) throw error;
        root = process.cwd();
      }
      return pullCommand(root, { url: flag(args, "url"), schema: flag(args, "schema"), tables: flag(args, "tables"), out: flag(args, "out"), force });
    }
    case "make:controller":
      printMake(makeController(findRoot(), needName("tasks --resource"), args.flags.get("resource") === true, force));
      return 0;
    case "make:model":
      printMake(makeModel(findRoot(), needName("task"), force));
      return 0;
    case "make:repository":
      printMake(makeRepository(findRoot(), needName("task"), force));
      return 0;
    case "make:service":
      printMake(makeService(findRoot(), needName("task"), force));
      return 0;
    case "make:middleware":
      printMake(makeMiddleware(findRoot(), needName("auth"), force));
      return 0;
    case "make:test":
      printMake(makeTest(findRoot(), needName("tasks"), force));
      return 0;
    case "make:migration":
      printMake(makeMigration(findRoot(), needName("create_tasks")));
      return 0;
    default:
      throw new CliError(`Unknown command "${command}". Run qala help.`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      if (error instanceof CliError) console.error(color.red(error.message));
      else console.error(error);
      process.exit(1);
    },
  );
}
