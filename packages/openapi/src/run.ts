#!/usr/bin/env bun
/**
 * `bun run.ts <root> <out> [--yaml]`: writes the OpenAPI document of the app in `root`. Run in its own
 * process by `qala openapi` / `qala generate` so the app's modules never load into the CLI.
 */
import { writeFileSync } from "node:fs";
import { toYaml } from "./index";
import { generateOpenApi } from "./load";

const [root, out, ...rest] = process.argv.slice(2);
if (root === undefined || out === undefined) {
  console.error("usage: bun run.ts <root> <out> [--yaml]");
  process.exit(2);
}
try {
  const doc = await generateOpenApi(root);
  writeFileSync(out, rest.includes("--yaml") ? toYaml(doc) : `${JSON.stringify(doc, null, 2)}\n`);
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
}
