import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { LAYOUT, importPath, pascal, rel, walk } from "./util";

/** How a column's text is turned into the field's value. */
export type FieldKind = "text" | "number" | "boolean" | "datetime";

/** `literal`: the field's type is a union of string literals (t.enum), so the decoded text is cast to it. */
/** `nullable`: the column may be NULL; `empty` is what the row holds then (`null` for t.nullable, `undefined` for a bare t.optional). */
export type ModelField = { name: string; kind: FieldKind; nullable: boolean; literal: boolean; empty?: "null" | "undefined" };

export type ModelInfo = {
  /** Absolute file path. */
  file: string;
  /** Path relative to the app root. */
  relFile: string;
  /** The exported const, e.g. `Task`. */
  exportName: string;
  table: string;
  fields: ModelField[];
};

/** A model the builder could not describe statically; the runtime keeps its generic decoder for it. */
export type SkippedModel = { relFile: string; exportName: string; line: number; reason: string };

export type ModelScan = { models: ModelInfo[]; skipped: SkippedModel[] };

const KINDS: Record<string, FieldKind> = {
  uuid: "text",
  string: "text",
  email: "text",
  enum: "text",
  unknown: "text",
  datetime: "datetime",
  integer: "number",
  number: "number",
  boolean: "boolean",
};

/** Every `export const X = model("table", { ... })` under app/, in file order. */
export function scanModels(root: string): ModelScan {
  const files = walk(join(root, LAYOUT.app), (f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
  const models: ModelInfo[] = [];
  const skipped: SkippedModel[] = [];
  for (const file of files) parseModels(root, file, models, skipped);
  return { models, skipped };
}

/** Local names `model` and `t` are imported under from @qala/core (null when not imported). */
function coreImports(source: ts.SourceFile): { model: string | null; t: string | null } {
  let model: string | null = null;
  let t: string | null = null;
  for (const stmt of source.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier) || stmt.moduleSpecifier.text !== "@qala/core") continue;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings) || stmt.importClause?.isTypeOnly === true) continue;
    for (const el of bindings.elements) {
      if (el.isTypeOnly) continue;
      const imported = (el.propertyName ?? el.name).text;
      if (imported === "model") model = el.name.text;
      if (imported === "t") t = el.name.text;
    }
  }
  return { model, t };
}

export function parseModels(root: string, file: string, models: ModelInfo[], skipped: SkippedModel[]): void {
  const text = readFileSync(file, "utf8");
  if (!text.includes("model")) return;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const names = coreImports(source);
  if (names.model === null) return;
  const relFile = rel(root, file);
  for (const stmt of source.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    if (!(stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)) continue;
    for (const decl of stmt.declarationList.declarations) {
      const init = decl.initializer;
      if (!ts.isIdentifier(decl.name) || init === undefined || !ts.isCallExpression(init)) continue;
      if (!ts.isIdentifier(init.expression) || init.expression.text !== names.model) continue;
      const exportName = decl.name.text;
      const line = source.getLineAndCharacterOfPosition(init.getStart(source)).line + 1;
      const result = describeModel(init, names.t);
      if (typeof result === "string") skipped.push({ relFile, exportName, line, reason: result });
      else models.push({ file, relFile, exportName, table: result.table, fields: result.fields });
    }
  }
}

function describeModel(call: ts.CallExpression, t: string | null): { table: string; fields: ModelField[] } | string {
  const [tableArg, shapeArg] = call.arguments;
  if (tableArg === undefined || !(ts.isStringLiteral(tableArg) || ts.isNoSubstitutionTemplateLiteral(tableArg))) return "the table name is not a string literal";
  if (shapeArg === undefined || !ts.isObjectLiteralExpression(shapeArg)) return "the shape is not an object literal";
  if (t === null) return "`t` is not imported from @qala/core";
  const fields: ModelField[] = [];
  for (const prop of shapeArg.properties) {
    if (!ts.isPropertyAssignment(prop)) return "the shape uses a spread, shorthand or method; write every field as `name: t.kind()`";
    const name = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
    if (name === null) return "the shape has a computed key";
    const field = describeField(prop.initializer, t);
    if (typeof field === "string") return `field "${name}": ${field}`;
    fields.push({ name, kind: field.kind, nullable: field.nullable, literal: field.literal, empty: field.empty });
  }
  return { table: tableArg.text, fields };
}

const COLUMN_MODIFIERS = new Set(["primary", "default", "defaultSql", "now", "unique", "index", "references", "referencesSelf", "type", "nullable"]);

function describeField(expr: ts.Expression, t: string): { kind: FieldKind; nullable: boolean; literal: boolean; empty: "null" | "undefined" } | string {
  let node = expr;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  // Column modifiers chained on a schema (`t.uuid().primary()`, `.default(false)`, `.nullable()`):
  // they do not change how the column decodes, except `.nullable()`.
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && !ts.isIdentifier(node.expression.expression)) {
    const modifier = node.expression.name.text;
    if (COLUMN_MODIFIERS.has(modifier)) {
      const inner = describeField(node.expression.expression, t);
      if (typeof inner === "string" || modifier !== "nullable") return inner;
      return { kind: inner.kind, nullable: true, literal: inner.literal, empty: "null" };
    }
  }
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || !ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== t) {
    return `not a ${t}.<kind>() call`;
  }
  const method = node.expression.name.text;
  if (method === "nullable" || method === "optional") {
    const inner = node.arguments[0];
    if (inner === undefined) return `${t}.${method}() needs a schema`;
    const described = describeField(inner, t);
    if (typeof described === "string") return described;
    const empty = method === "nullable" || (described.nullable && described.empty === "null") ? "null" : "undefined";
    return { kind: described.kind, nullable: true, literal: described.literal, empty };
  }
  const kind = KINDS[method];
  if (kind === undefined) return `${t}.${method}() has no column decoder (only scalar kinds are generated)`;
  return { kind, nullable: false, literal: method === "enum", empty: "null" };
}

/** The decoder expression for column `i`. */
export function fieldExpression(field: ModelField, i: number): string {
  const v = `v[${i}]`;
  const isNull = `${v} === null || ${v} === undefined`;
  const empty = field.empty ?? "null";
  switch (field.kind) {
    case "text":
      return field.nullable ? `${v} ?? ${empty}` : `${v} ?? ""`;
    case "number":
      return field.nullable ? `${isNull} ? ${empty} : Number(${v})` : `Number(${v})`;
    case "boolean":
      return field.nullable ? `${isNull} ? ${empty} : ${v} === "t"` : `${v} === "t"`;
    case "datetime":
      return field.nullable ? `${isNull} ? ${empty} : pgIso(${v})` : `pgIso(${v} ?? "")`;
  }
}

/** The local alias each model is imported under: its export name, or a path-qualified one when names clash. */
export function modelAliases(models: ModelInfo[]): string[] {
  const counts = new Map<string, number>();
  for (const m of models) counts.set(m.exportName, (counts.get(m.exportName) ?? 0) + 1);
  return models.map((m) => ((counts.get(m.exportName) ?? 0) > 1 ? `${pascal(m.relFile.replace(/^app\//, "").replace(/\.ts$/, ""))}${m.exportName}` : m.exportName));
}

export const MODELS_HEADER = "// generated by qala — do not edit\n";

/** `.qala/models.gen.ts`: registers a typed, statically compiled row decoder on every model. */
export function renderModels(root: string, models: ModelInfo[]): string {
  const dir = join(root, LAYOUT.generated);
  const aliases = modelAliases(models);
  const lines = [MODELS_HEADER, 'import { pgIso, type InferModel } from "@qala/core";'];
  models.forEach((m, i) => {
    const a = aliases[i]!;
    lines.push(`import { ${a === m.exportName ? a : `${m.exportName} as ${a}`} } from "${importPath(dir, m.file)}";`);
  });
  lines.push("");
  models.forEach((m, i) => {
    const a = aliases[i]!;
    const props = m.fields.map((f, n) => {
      const key = /^[A-Za-z_$][\w$]*$/.test(f.name) ? f.name : JSON.stringify(f.name);
      const value = f.literal ? `(${fieldExpression(f, n)}) as InferModel<typeof ${a}>[${JSON.stringify(f.name)}]` : fieldExpression(f, n);
      return `${key}: ${value}`;
    });
    lines.push(`${a}.useDecoder((v: (string | null)[]): InferModel<typeof ${a}> => ({ ${props.join(", ")} }));`);
  });
  lines.push("");
  return lines.join("\n");
}
