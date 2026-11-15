import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as ts from "typescript";
import { LAYOUT, rel, walk } from "./util";

/** The architectural layer of a file (by its path relative to the app root), or null if it is not checked. */
export type Layer = "domain" | "application" | "infrastructure" | "http" | "shared" | "root";

export function layerOf(relPath: string): Layer | null {
  if (relPath.startsWith("app/domain/")) return "domain";
  if (relPath.startsWith("app/application/")) return "application";
  if (relPath.startsWith("app/infrastructure/")) return "infrastructure";
  if (relPath.startsWith("app/http/")) return "http";
  if (relPath.startsWith("app/shared/")) return "shared";
  if (relPath === LAYOUT.providers || relPath === LAYOUT.kernel || relPath.startsWith("config/")) return "root";
  return null;
}

/** Which layers each layer may import (project files). Composition roots may import anything. */
const ALLOWED: Record<Exclude<Layer, "root">, Layer[]> = {
  domain: ["domain", "shared"],
  application: ["domain", "application", "shared"],
  infrastructure: ["domain", "application", "infrastructure", "shared"],
  http: ["domain", "application", "http", "shared"],
  shared: ["shared"],
};

/** Packages each layer may import. `*` = any package (infrastructure talks to the outside world). */
const PACKAGES: Record<Exclude<Layer, "root">, string[]> = {
  domain: ["@qala/core"],
  application: ["@qala/core"],
  infrastructure: ["*"],
  http: ["@qala/core"],
  shared: ["@qala/core"],
};

const WHY: Record<Exclude<Layer, "root">, string> = {
  domain: "the domain is the core: it depends on nothing but itself (and @qala/core schemas/errors)",
  application: "the application layer uses the domain; reach infrastructure through abstract classes in app/domain bound in app/providers.ts",
  infrastructure: "infrastructure implements domain/application contracts; it must not depend on the HTTP layer",
  http: "controllers call application services; never repositories or other infrastructure directly",
  shared: "shared code must stay dependency-free",
};

export type Violation = { file: string; line: number; layer: Layer; target: string; message: string };

function packageName(spec: string): string {
  if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
  return spec.split("/")[0]!;
}

function resolveImport(fromFile: string, spec: string): string {
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ""));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return base.endsWith(".ts") ? base : `${base}.ts`;
}

/** Module specifiers a file imports or re-exports, with their lines (type-only imports included: they couple layers too). */
export function importsOf(file: string): { spec: string; line: number }[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const out: { spec: string; line: number }[] = [];
  const add = (node: ts.Node, spec: ts.Expression | undefined) => {
    if (spec !== undefined && ts.isStringLiteral(spec)) out.push({ spec: spec.text, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node, node.moduleSpecifier);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, node.arguments[0]);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node, node.argument.literal as ts.Expression);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** Checks the Clean Architecture dependency rule over every .ts file in app/ and config/. */
export function checkArchitecture(root: string): { files: number; violations: Violation[] } {
  const files = [...walk(join(root, LAYOUT.app)), ...walk(join(root, "config"))].filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
  const violations: Violation[] = [];
  for (const file of files) {
    const relFile = rel(root, file);
    const layer = layerOf(relFile);
    if (layer === null || layer === "root") continue;
    for (const { spec, line } of importsOf(file)) {
      if (spec.startsWith(".") || spec.startsWith("/")) {
        const target = resolveImport(file, spec);
        const targetRel = rel(root, target);
        const targetLayer = layerOf(targetRel);
        if (targetLayer === "root") {
          violations.push({ file: relFile, line, layer, target: targetRel, message: `${layer} imports the composition root ${targetRel}; only .qala/main.ts wires the app` });
        } else if (targetLayer === null) {
          if (!targetRel.startsWith("app/") && !targetRel.startsWith("..")) continue;
          violations.push({ file: relFile, line, layer, target: targetRel, message: `${layer} imports ${targetRel}, which is outside the layers (app/domain, app/application, app/infrastructure, app/http, app/shared)` });
        } else if (!ALLOWED[layer].includes(targetLayer)) {
          violations.push({ file: relFile, line, layer, target: targetRel, message: `${layer} must not import ${targetLayer} (${targetRel}): ${WHY[layer]}` });
        }
        continue;
      }
      const allowed = PACKAGES[layer];
      if (allowed.includes("*")) continue;
      const pkg = packageName(spec);
      if (!allowed.includes(pkg)) {
        violations.push({ file: relFile, line, layer, target: spec, message: `${layer} must not import the package "${spec}": ${layer === "domain" ? "keep the domain pure" : "wrap it in app/infrastructure behind an abstract class from app/domain"}` });
      }
    }
  }
  return { files: files.length, violations };
}
