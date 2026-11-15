import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CliError, LAYOUT, importPath, rel, walk, writeIfChanged } from "./util";

/** Where query declarations live (build-time only: they are compiled, never shipped). */
export const QUERIES_DIR = "app/infrastructure/queries";
export const QUERIES_GEN = "queries.gen.ts";

export function queryFiles(root: string): string[] {
  return walk(join(root, QUERIES_DIR), (f) => f.endsWith(".query.ts"));
}

/**
 * The compile step runs inside the app (with its own tsconfig paths), so the declarations and the
 * compiler share one copy of `@qala/core/query`. It prints `{ content, count }` or `{ error }` as JSON.
 */
function compileScript(root: string, files: string[]): string {
  const dir = join(root, LAYOUT.generated);
  const imports = files.map((f, i) => `import * as m${i} from ${JSON.stringify(importPath(dir, f))};`);
  const modules = files.map((f, i) => `[${JSON.stringify(importPath(dir, f))}, ${JSON.stringify(rel(root, f))}, m${i}]`);
  return `// Temporary: written and removed by \`qala generate\`.
import { compileQuery, emitQueries, isQueryDef, type EmitEntry } from "@qala/core/query";
${imports.join("\n")}

const modules: [string, string, Record<string, unknown>][] = [${modules.join(", ")}];
try {
  const entries: EmitEntry[] = [];
  const seen = new Map<string, string>();
  for (const [from, file, mod] of modules) {
    for (const [name, value] of Object.entries(mod)) {
      if (!isQueryDef(value)) continue;
      const other = seen.get(name);
      if (other !== undefined) throw new Error(\`query "\${name}" is declared in \${other} and \${file}; query names must be unique\`);
      seen.set(name, file);
      try {
        entries.push({ name, exportName: name, from, plan: compileQuery(value) });
      } catch (error) {
        throw new Error(\`\${file}: query "\${name}": \${error instanceof Error ? error.message : String(error)}\`);
      }
    }
  }
  console.log(JSON.stringify({ content: emitQueries(entries), count: entries.length }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}
`;
}

export type QueriesResult = { count: number; written: boolean };

/**
 * Compiles every `defineQuery` in app/infrastructure/queries/*.query.ts into `.qala/queries.gen.ts`
 * (final SQL + typed parameter mappers + typed decoders). Removes a stale file when there are none.
 */
export function generateQueries(root: string): QueriesResult {
  const files = queryFiles(root);
  const out = join(root, LAYOUT.generated, QUERIES_GEN);
  if (files.length === 0) {
    if (existsSync(out)) rmSync(out);
    return { count: 0, written: false };
  }
  const script = join(root, LAYOUT.generated, "compile-queries.ts");
  writeIfChanged(script, compileScript(root, files));
  try {
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    const line = (result.stdout ?? "").trim().split("\n").pop() ?? "";
    let parsed: { content?: string; count?: number; error?: string };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      throw new CliError(`Compiling queries failed:\n${result.stderr || result.stdout}`);
    }
    if (parsed.error !== undefined) throw new CliError(`Compiling queries failed: ${parsed.error}`);
    const written = writeIfChanged(out, parsed.content ?? "");
    return { count: parsed.count ?? 0, written };
  } finally {
    rmSync(script, { force: true });
  }
}

/** Keeps the helper available to tests without running Bun. */
export function renderCompileScript(root: string, files: string[]): string {
  return compileScript(root, files);
}

