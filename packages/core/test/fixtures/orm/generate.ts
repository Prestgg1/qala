/** Regenerates `queries.gen.ts` for the ORM tests: `bun packages/core/test/fixtures/orm/generate.ts`. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileQuery, emitQueries, isQueryDef } from "@qala/core/query";
import * as declared from "./queries";

export function render(): string {
  const entries = [];
  for (const [name, value] of Object.entries(declared)) if (isQueryDef(value)) entries.push({ name, exportName: name, from: "./queries", plan: compileQuery(value) });
  return emitQueries(entries);
}

if (import.meta.main) writeFileSync(join(import.meta.dir, "queries.gen.ts"), render());
