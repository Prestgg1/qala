/**
 * Automatic dependency injection, decided at build time (scriptc has no run-time reflection).
 *
 * `qala generate` reads the constructor parameter types of the app's classes and writes
 * `.qala/providers.gen.ts`: one `singleton<X>(X, (c) => new X(c.get<A>(A), …))` per class it can build, and
 * `bind<Abstract>(Abstract, Impl)` when an abstract class has exactly one concrete subclass. `app/providers.ts`
 * becomes optional and holds only overrides (`provide(Database, () => …)`, `bind(Mailer, SmtpMailer)`); they are
 * registered after the generated providers, so they win.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as ts from "typescript";
import { CliError, LAYOUT, importPath, pascal, rel, walk } from "./util";

/** A class (in the app) or an imported token (from a package such as @qala/core). */
type Ref = { kind: "class"; key: string } | { kind: "external"; module: string; name: string };

type Param = { name: string; type: Ref | null; typeText: string; optional: boolean; line: number };

type ClassInfo = {
  key: string;
  name: string;
  file: string;
  relFile: string;
  line: number;
  abstract: boolean;
  base: Ref | null;
  /** Own constructor parameters; null when the class declares no constructor (it inherits its base's). */
  params: Param[] | null;
};

export type DiResult = {
  /** The generated file's content, or null when there is nothing to generate. */
  source: string | null;
  /** Problems that make the app unbuildable (needed classes that cannot be constructed). */
  errors: string[];
  /** Problems that may be fine at run time (app/providers.ts is too dynamic to read). */
  warnings: string[];
  /** Number of providers generated. */
  count: number;
};

const OVERRIDE_HELPERS = new Set(["provide", "bind", "singleton", "transient", "value"]);
const SCANNED_LAYERS = [LAYOUT.application, LAYOUT.infrastructure, "app/http"];

function refKey(r: Ref): string {
  return r.kind === "class" ? r.key : `${r.module}#${r.name}`;
}

function isExported(node: ts.Node): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/** Resolves a relative module specifier to a .ts file, or null. */
function resolveModule(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) if (candidate.endsWith(".ts") && existsSync(candidate)) return candidate;
  return null;
}

class Scanner {
  readonly classes = new Map<string, ClassInfo>();
  private readonly sources = new Map<string, ts.SourceFile>();

  constructor(private readonly root: string) {}

  source(file: string): ts.SourceFile {
    let sf = this.sources.get(file);
    if (sf === undefined) {
      sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
      this.sources.set(file, sf);
    }
    return sf;
  }

  /** What identifier `name` refers to in `file`: a class in the app, an imported package token, or null. */
  resolveName(file: string, name: string, depth = 0): Ref | null {
    if (depth > 8) return null;
    const sf = this.source(file);
    for (const stmt of sf.statements) {
      if (ts.isClassDeclaration(stmt) && stmt.name?.text === name) return { kind: "class", key: `${file}#${name}` };
    }
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const bindings = stmt.importClause?.namedBindings;
        if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
        for (const el of bindings.elements) {
          if (el.name.text !== name) continue;
          const imported = (el.propertyName ?? el.name).text;
          const spec = stmt.moduleSpecifier.text;
          const target = resolveModule(file, spec);
          if (target === null) return spec.startsWith(".") ? null : { kind: "external", module: spec, name: imported };
          return this.resolveExport(target, imported, depth + 1);
        }
      }
    }
    return null;
  }

  /** The class exported as `name` by `file`, following `export { x } from` and `export * from`. */
  private resolveExport(file: string, name: string, depth: number): Ref | null {
    if (depth > 8) return null;
    const sf = this.source(file);
    for (const stmt of sf.statements) {
      if (ts.isClassDeclaration(stmt) && stmt.name?.text === name && isExported(stmt)) return { kind: "class", key: `${file}#${name}` };
    }
    for (const stmt of sf.statements) {
      if (!ts.isExportDeclaration(stmt)) continue;
      const spec = stmt.moduleSpecifier !== undefined && ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : null;
      const clause = stmt.exportClause;
      if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const el of clause.elements) {
          if (el.name.text !== name) continue;
          const original = (el.propertyName ?? el.name).text;
          if (spec === null) return this.resolveName(file, original, depth + 1);
          const target = resolveModule(file, spec);
          if (target === null) return spec.startsWith(".") ? null : { kind: "external", module: spec, name: original };
          return this.resolveExport(target, original, depth + 1);
        }
      } else if (clause === undefined && spec !== null) {
        const target = resolveModule(file, spec);
        if (target !== null) {
          const found = this.resolveExport(target, name, depth + 1);
          if (found !== null) return found;
        }
      }
    }
    // `import { X } from "./y"; export { X };` style
    for (const stmt of sf.statements) {
      if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier === undefined) return this.resolveName(file, name, depth + 1);
    }
    return null;
  }

  /** Records every class declared in `file` (exported or not: only exported ones can be generated). */
  scanFile(file: string): void {
    const sf = this.source(file);
    for (const stmt of sf.statements) {
      if (!ts.isClassDeclaration(stmt) || stmt.name === undefined) continue;
      const name = stmt.name.text;
      const key = `${file}#${name}`;
      const abstract = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword) ?? false;
      let base: Ref | null = null;
      for (const clause of stmt.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        const expr = clause.types[0]?.expression;
        if (expr !== undefined && ts.isIdentifier(expr)) base = this.resolveName(file, expr.text) ?? { kind: "external", module: "?", name: expr.text };
      }
      let params: Param[] | null = null;
      for (const member of stmt.members) {
        if (!ts.isConstructorDeclaration(member) || member.body === undefined) continue;
        params = member.parameters.map((p) => {
          const pname = ts.isIdentifier(p.name) ? p.name.text : "?";
          const typeNode = p.type;
          const typeText = typeNode === undefined ? "" : typeNode.getText(sf);
          let type: Ref | null = null;
          if (typeNode !== undefined && ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName) && typeNode.typeArguments === undefined) {
            type = this.resolveName(file, typeNode.typeName.text);
          }
          const optional = p.questionToken !== undefined || p.initializer !== undefined;
          return { name: pname, type, typeText, optional, line: sf.getLineAndCharacterOfPosition(p.getStart(sf)).line + 1 };
        });
      }
      this.classes.set(key, {
        key,
        name,
        file,
        relFile: rel(this.root, file),
        line: sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1,
        abstract,
        base,
        params,
      });
    }
  }
}

/** Overrides read from app/providers.ts: tokens it registers, and whether it is too dynamic to read fully. */
function readOverrides(scanner: Scanner, root: string): { tokens: Set<string>; opaque: boolean } {
  const file = join(root, LAYOUT.providers);
  const tokens = new Set<string>();
  if (!existsSync(file)) return { tokens, opaque: false };
  const sf = scanner.source(file);
  let opaque = false;
  const visit = (node: ts.Node): void => {
    if (ts.isSpreadElement(node)) opaque = true;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && OVERRIDE_HELPERS.has(node.expression.text)) {
      const first = node.arguments[0];
      if (first !== undefined && ts.isIdentifier(first)) {
        const ref = scanner.resolveName(file, first.text);
        if (ref !== null) tokens.add(refKey(ref));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // `export const providers = someOtherArray` (not an array literal) is just as opaque as a spread.
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === "providers" && decl.initializer !== undefined) {
        let init = decl.initializer;
        while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
        if (!ts.isArrayLiteralExpression(init)) opaque = true;
      }
    }
  }
  return { tokens, opaque };
}

/** Class keys the routes need: class controllers and the dependency tokens of `controller({ ... })` calls. */
export type DiRoots = { classControllers: { file: string; name: string }[]; functionControllerFiles: string[] };

function rootKeys(scanner: Scanner, roots: DiRoots): { key: string; where: string }[] {
  const out: { key: string; where: string }[] = [];
  for (const c of roots.classControllers) out.push({ key: `${c.file}#${c.name}`, where: `${rel(dirname(dirname(dirname(c.file))), c.file)}` });
  for (const file of roots.functionControllerFiles) {
    const sf = scanner.source(file);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "controller") {
        const deps = node.arguments[0];
        if (deps !== undefined && ts.isObjectLiteralExpression(deps)) {
          for (const prop of deps.properties) {
            if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)) {
              const ref = scanner.resolveName(file, prop.initializer.text);
              if (ref !== null && ref.kind === "class") out.push({ key: ref.key, where: `${file}` });
            } else if (ts.isShorthandPropertyAssignment(prop)) {
              const ref = scanner.resolveName(file, prop.name.text);
              if (ref !== null && ref.kind === "class") out.push({ key: ref.key, where: `${file}` });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/** Builds the providers file for the app at `root`. */
export function generateProviders(root: string, roots: DiRoots): DiResult {
  const scanner = new Scanner(root);
  const appDir = join(root, LAYOUT.app);
  const files = walk(appDir, (f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.endsWith(".test.ts") && !f.endsWith(".query.ts"));
  for (const f of files) scanner.scanFile(f);
  const overrides = readOverrides(scanner, root);
  const errors: string[] = [];
  const warnings: string[] = [];

  /** Constructor parameters of a class, inherited from its base when it declares none. */
  const ctorParams = (info: ClassInfo, seen = 0): { params: Param[]; from: ClassInfo } | string => {
    if (info.params !== null) return { params: info.params, from: info };
    if (info.base === null) return { params: [], from: info };
    if (info.base.kind === "external") return `extends ${info.base.name} from outside the app and declares no constructor`;
    const base = scanner.classes.get(info.base.key);
    if (base === undefined || seen > 10) return "its base class could not be read";
    return ctorParams(base, seen + 1);
  };

  const implementations = (abstractKey: string): ClassInfo[] => {
    const out: ClassInfo[] = [];
    for (const c of scanner.classes.values()) {
      if (c.abstract) continue;
      let base = c.base;
      for (let i = 0; base !== null && base.kind === "class" && i < 10; i++) {
        if (base.key === abstractKey) {
          out.push(c);
          break;
        }
        base = scanner.classes.get(base.key)?.base ?? null;
      }
    }
    return out;
  };

  /** How a token is satisfied, or why it cannot be. Memoised; cycles are reported separately. */
  type Plan = { kind: "construct"; info: ClassInfo; deps: (Ref | null)[] } | { kind: "bind"; info: ClassInfo; impl: ClassInfo } | { kind: "provided" } | { kind: "missing"; reason: string };
  const plans = new Map<string, Plan>();
  const planFor = (ref: Ref): Plan => {
    const key = refKey(ref);
    const cached = plans.get(key);
    if (cached !== undefined) return cached;
    let plan: Plan;
    if (overrides.tokens.has(key)) plan = { kind: "provided" };
    else if (ref.kind === "external") {
      plan = overrides.opaque ? { kind: "provided" } : { kind: "missing", reason: `${ref.name} (from ${ref.module}) is not a class in app/; register it in app/providers.ts, e.g. provide(${ref.name}, () => new ${ref.name}(…))` };
    } else {
      const info = scanner.classes.get(ref.key);
      if (info === undefined) plan = { kind: "missing", reason: "is not a class the builder can read" };
      else if (info.abstract) {
        const impls = implementations(info.key);
        if (impls.length === 1) plan = { kind: "bind", info, impl: impls[0]! };
        else if (overrides.opaque) plan = { kind: "provided" };
        else if (impls.length === 0) plan = { kind: "missing", reason: `abstract ${info.name} has no implementation; write a class that extends it, or provide(${info.name}, …) in app/providers.ts` };
        else plan = { kind: "missing", reason: `abstract ${info.name} has ${impls.length} implementations (${impls.map((i) => i.name).join(", ")}); choose one in app/providers.ts: bind(${info.name}, ${impls[0]!.name})` };
      } else {
        const ctor = ctorParams(info);
        if (typeof ctor === "string") plan = { kind: "missing", reason: `${info.name} ${ctor}` };
        else {
          const deps: (Ref | null)[] = [];
          let reason: string | null = null;
          for (const p of ctor.params) {
            if (p.type === null) {
              if (p.optional) break;
              reason = `${info.name}'s constructor parameter "${p.name}: ${p.typeText || "(no type)"}" (${ctor.from.relFile}:${p.line}) is not a class; give it a default value, or build ${info.name} yourself: provide(${info.name}, (c) => new ${info.name}(…))`;
              break;
            }
            deps.push(p.type);
          }
          plan = reason === null ? { kind: "construct", info, deps } : { kind: "missing", reason };
        }
      }
    }
    plans.set(key, plan);
    return plan;
  };

  /** Whether everything below `ref` can be built; records the first problem. */
  const satisfiable = (ref: Ref, stack: string[], problem: { text: string | null }): boolean => {
    const key = refKey(ref);
    if (stack.includes(key)) {
      const names = [...stack.slice(stack.indexOf(key)), key].map((k) => k.split("#")[1]);
      problem.text = `circular dependency: ${names.join(" → ")}`;
      return false;
    }
    const plan = planFor(ref);
    if (plan.kind === "provided") return true;
    if (plan.kind === "missing") {
      problem.text = plan.reason;
      return false;
    }
    const next = [...stack, key];
    if (plan.kind === "bind") return satisfiable({ kind: "class", key: plan.impl.key }, next, problem);
    for (const dep of plan.deps) if (dep !== null && !satisfiable(dep, next, problem)) return false;
    return true;
  };

  // Needed tokens: what the routes use. Their failures are errors.
  for (const root of rootKeys(scanner, roots)) {
    const problem = { text: null as string | null };
    if (!satisfiable({ kind: "class", key: root.key }, [], problem)) {
      const info = scanner.classes.get(root.key);
      const text = `${info?.relFile ?? root.where}: ${info?.name ?? root.key} cannot be built: ${problem.text}`;
      if (overrides.opaque && !problem.text?.startsWith("circular")) warnings.push(text);
      else errors.push(text);
    }
  }

  // Every exported class in the scanned layers that can be built gets a provider (so app code can resolve it).
  const scannedDirs = SCANNED_LAYERS.map((d) => join(root, d));
  const emit: Plan[] = [];
  const emitted = new Set<string>();
  const include = (ref: Ref): void => {
    const key = refKey(ref);
    if (emitted.has(key)) return;
    const plan = planFor(ref);
    if (plan.kind !== "construct" && plan.kind !== "bind") return;
    if (!satisfiable(ref, [], { text: null })) return;
    emitted.add(key);
    emit.push(plan);
    if (plan.kind === "bind") include({ kind: "class", key: plan.impl.key });
    else for (const d of plan.deps) if (d !== null) include(d);
  };
  for (const c of [...scanner.classes.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const exported = isExported(scanner.source(c.file).statements.find((s) => ts.isClassDeclaration(s) && s.name?.text === c.name) ?? scanner.source(c.file));
    if (!exported) continue;
    if (!scannedDirs.some((d) => c.file.startsWith(d))) continue;
    include({ kind: "class", key: c.key });
  }
  for (const root of rootKeys(scanner, roots)) include({ kind: "class", key: root.key });

  if (emit.length === 0) return { source: null, errors, warnings, count: 0 };
  return { source: render(root, scanner, emit as Exclude<Plan, { kind: "provided" } | { kind: "missing" }>[]), errors, warnings, count: emit.length };
}

function render(root: string, scanner: Scanner, plans: ({ kind: "construct"; info: ClassInfo; deps: (Ref | null)[] } | { kind: "bind"; info: ClassInfo; impl: ClassInfo })[]): string {
  const dir = join(root, LAYOUT.generated);
  // Local names: the class name, or a path-qualified one when two classes share it.
  const counts = new Map<string, number>();
  const refs = new Map<string, Ref>();
  const note = (r: Ref): void => {
    refs.set(refKey(r), r);
  };
  for (const p of plans) {
    note({ kind: "class", key: p.info.key });
    if (p.kind === "bind") note({ kind: "class", key: p.impl.key });
    else for (const d of p.deps) if (d !== null) note(d);
  }
  const plainName = (r: Ref): string => (r.kind === "class" ? r.key.split("#")[1]! : r.name);
  for (const r of refs.values()) counts.set(plainName(r), (counts.get(plainName(r)) ?? 0) + 1);
  const local = (r: Ref): string => {
    const name = plainName(r);
    if ((counts.get(name) ?? 0) <= 1) return name;
    if (r.kind === "external") return `${pascal(r.module.replace(/[^a-zA-Z0-9]+/g, " "))}${name}`;
    const relDir = rel(join(root, LAYOUT.app), dirname(r.key.split("#")[0]!));
    return `${pascal(relDir.replace(/[^a-zA-Z0-9]+/g, " "))}${name}`;
  };

  const imports = new Map<string, Set<string>>();
  for (const r of [...refs.values()].sort((a, b) => (refKey(a) < refKey(b) ? -1 : 1))) {
    const from = r.kind === "class" ? importPath(dir, r.key.split("#")[0]!) : r.module;
    const name = plainName(r);
    const as = local(r);
    let set = imports.get(from);
    if (set === undefined) {
      set = new Set();
      imports.set(from, set);
    }
    set.add(as === name ? name : `${name} as ${as}`);
  }
  const usesBind = plans.some((p) => p.kind === "bind");
  const lines = [
    "// Generated by `qala generate`. Do not edit: changes are overwritten.",
    "// One provider per class the builder can construct from its constructor parameter types.",
    "// Override any of them in app/providers.ts (provide/bind), which is registered after this list.",
    "",
    `import { ${usesBind ? "bind, " : ""}singleton, type Provider } from "@qala/core";`,
  ];
  for (const [from, names] of [...imports.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (from === "@qala/core") {
      lines[4] = `import { ${usesBind ? "bind, " : ""}singleton, type Provider, ${[...names].sort().join(", ")} } from "@qala/core";`;
      continue;
    }
    lines.push(`import { ${[...names].sort().join(", ")} } from "${from}";`);
  }
  lines.push("", "export const generatedProviders: Provider[] = [");
  for (const p of plans) {
    const t = local({ kind: "class", key: p.info.key });
    if (p.kind === "bind") {
      const impl = local({ kind: "class", key: p.impl.key });
      lines.push(`  bind<${t}>(${t}, ${impl}),`);
      continue;
    }
    const args = p.deps.map((d) => {
      const n = local(d!);
      return `c.get<${n}>(${n})`;
    });
    lines.push(`  singleton<${t}>(${t}, (${args.length > 0 ? "c" : ""}) => new ${t}(${args.join(", ")})),`);
  }
  lines.push("];", "");
  void scanner;
  return lines.join("\n");
}

/** Throws a CliError for unbuildable providers (used by generate). */
export function assertProviders(result: DiResult): void {
  if (result.errors.length > 0) throw new CliError(`Dependency injection problems:\n  ${result.errors.join("\n  ")}`);
}
