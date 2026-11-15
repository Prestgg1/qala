import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as ts from "typescript";
import { LAYOUT, rel, walk } from "./util";

/**
 * `qala check --fix`: finds the scriptc pitfalls from docs/scriptc.md in app code and rewrites them with
 * minimal text edits (TypeScript compiler API, so formatting and comments around the edit stay as they are).
 */
export type Fix = { file: string; line: number; message: string };
export type FixReport = { fixes: Fix[]; unfixable: Fix[]; files: string[] };

type Edit = { start: number; end: number; text: string };

class Pass {
  readonly edits = new Map<string, Edit[]>();
  readonly fixes: Fix[] = [];
  readonly unfixable: Fix[] = [];
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly targets = new Set<string>();

  constructor(private readonly root: string) {
    const names = [...walk(join(root, LAYOUT.app)), ...walk(join(root, "config"))].filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
    for (const n of names) this.targets.add(resolve(n));
    let options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, skipLibCheck: true };
    let rootNames = names;
    const tsconfig = join(root, "tsconfig.json");
    if (existsSync(tsconfig)) {
      const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, root);
      options = parsed.options;
      rootNames = [...new Set([...parsed.fileNames, ...names])];
    }
    this.program = ts.createProgram(rootNames, { ...options, noEmit: true });
    this.checker = this.program.getTypeChecker();
  }

  run(): void {
    for (const sf of this.program.getSourceFiles()) {
      if (!this.targets.has(resolve(sf.fileName))) continue;
      this.defaultExport(sf);
      const visit = (node: ts.Node): void => {
        if (ts.isClassDeclaration(node)) this.asyncOverrides(sf, node);
        else if (ts.isCallExpression(node)) this.diCall(sf, node);
        else if (ts.isArrayLiteralExpression(node)) this.emptyArray(sf, node);
        else if (ts.isImportDeclaration(node)) this.defaultImport(sf, node);
        else if (ts.isExportDeclaration(node)) this.exportStar(sf, node);
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }

  // ─── bookkeeping ────────────────────────────────────────────────────────────

  private line(sf: ts.SourceFile, pos: number): number {
    return sf.getLineAndCharacterOfPosition(pos).line + 1;
  }

  private fix(sf: ts.SourceFile, node: ts.Node, message: string, edits: Edit[]): void {
    const list = this.edits.get(sf.fileName) ?? [];
    list.push(...edits);
    this.edits.set(sf.fileName, list);
    this.fixes.push({ file: rel(this.root, sf.fileName), line: this.line(sf, node.getStart(sf)), message });
  }

  private skip(sf: ts.SourceFile, node: ts.Node, message: string): void {
    this.unfixable.push({ file: rel(this.root, sf.fileName), line: this.line(sf, node.getStart(sf)), message });
  }

  private isAbstractClass(expr: ts.Expression): boolean {
    let symbol = this.checker.getSymbolAtLocation(expr);
    if (symbol === undefined) return false;
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = this.checker.getAliasedSymbol(symbol);
    return (symbol.declarations ?? []).some((d) => ts.isClassDeclaration(d) && (ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Abstract) !== 0);
  }

  // ─── 1. async methods overriding abstract methods ───────────────────────────

  private asyncOverrides(sf: ts.SourceFile, cls: ts.ClassDeclaration): void {
    if (cls.heritageClauses === undefined || cls.name === undefined) return;
    const type = this.checker.getTypeAtLocation(cls.name);
    const bases = this.checker.getBaseTypes(type as ts.InterfaceType);
    for (const m of cls.members) {
      if (!ts.isMethodDeclaration(m) || !ts.isIdentifier(m.name) || m.body === undefined) continue;
      const modifiers = ts.getModifiers(m) ?? [];
      if (!modifiers.some((x) => x.kind === ts.SyntaxKind.AsyncKeyword)) continue;
      const name = m.name.text;
      const overridesAbstract = bases.some((b) => (this.checker.getPropertyOfType(b, name)?.declarations ?? []).some((d) => (ts.getCombinedModifierFlags(d as ts.Declaration) & ts.ModifierFlags.Abstract) !== 0));
      if (!overridesAbstract) continue;
      const args: string[] = [];
      let ok = m.typeParameters === undefined;
      for (const p of m.parameters) {
        if (!ts.isIdentifier(p.name)) ok = false;
        else args.push(`${p.dotDotDotToken ? "..." : ""}${p.name.text}`);
      }
      if (!ok) {
        this.skip(sf, m, `${cls.name.text}.${name}: async method overrides an abstract method; make it non-async by hand (generic or destructured parameters)`);
        continue;
      }
      const start = m.getStart(sf);
      const lineStart = sf.text.lastIndexOf("\n", start - 1) + 1;
      const indent = sf.text.slice(lineStart, start).replace(/\S.*$/, "");
      const kept = modifiers.filter((x) => x.kind !== ts.SyntaxKind.AsyncKeyword && x.kind !== ts.SyntaxKind.PublicKeyword).map((x) => x.getText(sf) + " ");
      const ret = m.type === undefined ? "" : `: ${m.type.getText(sf)}`;
      const helper = `${name}Async`;
      const wrapper = `${kept.join("")}${name}(${m.parameters.map((p) => p.getText(sf)).join(", ")})${ret} { return this.${helper}(${args.join(", ")}); }\n\n${indent}private async ${helper}`;
      this.fix(sf, m, `${cls.name.text}.${name}: async override of an abstract method -> non-async, delegating to private async ${helper}`, [{ start, end: m.name.end, text: wrapper }]);
    }
  }

  // ─── 2 + 3. singleton/value/transient with an abstract token ─────────────────

  private diCall(sf: ts.SourceFile, call: ts.CallExpression): void {
    if (!ts.isIdentifier(call.expression) || !["singleton", "transient", "value"].includes(call.expression.text)) return;
    const token = call.arguments[0];
    if (token === undefined || !ts.isIdentifier(token) || !this.isAbstractClass(token)) return;
    const fn = call.arguments[1];
    const callee = call.expression.text;
    if (call.typeArguments === undefined) {
      this.fix(sf, call, `${callee}(${token.text}, ...): explicit type argument <${token.text}> for an abstract token`, [{ start: call.expression.end, end: call.expression.end, text: `<${token.text}>` }]);
    }
    if (callee === "value" || fn === undefined || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || fn.type !== undefined) return;
    const sig = this.checker.getSignatureFromDeclaration(fn);
    if (sig === undefined) return;
    const ret = this.checker.getReturnTypeOfSignature(sig);
    if (!ret.isUnion() || (ret.flags & ts.TypeFlags.Boolean) !== 0) return;
    const close = fn.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.CloseParenToken);
    const edit: Edit =
      close !== undefined
        ? { start: close.end, end: close.end, text: `: ${token.text}` }
        : { start: fn.parameters[0]!.getStart(sf), end: fn.parameters[0]!.end, text: `(${fn.parameters[0]!.getText(sf)}): ${token.text}` };
    this.fix(sf, fn, `${callee}(${token.text}, ...): factory returns a union; annotated the return type as ${token.text}`, [edit]);
  }

  // ─── 4. empty array literals in typed object slots ──────────────────────────

  private emptyArray(sf: ts.SourceFile, node: ts.ArrayLiteralExpression): void {
    if (node.elements.length > 0 || !ts.isPropertyAssignment(node.parent) || !ts.isObjectLiteralExpression(node.parent.parent)) return;
    const contextual = this.checker.getContextualType(node);
    if (contextual === undefined) return;
    const candidates = contextual.isUnion() ? contextual.types : [contextual];
    const arrayType = candidates.find((t) => this.checker.isArrayType(t));
    if (arrayType === undefined) return;
    const text = this.checker.typeToString(arrayType, undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);
    if (/\b(never|any)\b/.test(text)) return;
    this.fix(sf, node, `empty array literal for "${node.parent.name.getText(sf)}": added "as ${text}"`, [{ start: node.end, end: node.end, text: ` as ${text}` }]);
  }

  // ─── 5. default exports / imports ───────────────────────────────────────────

  private readonly defaults = new Map<string, string | null>();

  /** Rewrites `export default class Foo` / `function foo` / `export default foo;` and records the exported name. */
  private defaultExport(sf: ts.SourceFile): string | null {
    const known = this.defaults.get(sf.fileName);
    if (known !== undefined) return known;
    let name: string | null = null;
    for (const st of sf.statements) {
      const mods = ts.canHaveModifiers(st) ? (ts.getModifiers(st) ?? []) : [];
      const def = mods.find((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      if ((ts.isClassDeclaration(st) || ts.isFunctionDeclaration(st)) && def !== undefined) {
        if (st.name === undefined) {
          this.skip(sf, st, "anonymous default export: give it a name and export it by name");
          name = null;
          continue;
        }
        name = st.name.text;
        const next = def.end;
        const after = sf.text.slice(next).match(/^\s+/)?.[0].length ?? 0;
        this.fix(sf, st, `export default ${name} -> export ${name}`, [{ start: def.getStart(sf), end: next + after, text: "" }]);
      } else if (ts.isExportAssignment(st) && !st.isExportEquals) {
        if (ts.isIdentifier(st.expression)) {
          name = st.expression.text;
          this.fix(sf, st, `export default ${name} -> export { ${name} }`, [{ start: st.getStart(sf), end: st.end, text: `export { ${name} };` }]);
        } else this.skip(sf, st, "default export of an expression: name it (const x = ...; export { x })");
      }
    }
    this.defaults.set(sf.fileName, name);
    return name;
  }

  private defaultImport(sf: ts.SourceFile, decl: ts.ImportDeclaration): void {
    const clause = decl.importClause;
    if (clause === undefined || clause.name === undefined || !ts.isStringLiteral(decl.moduleSpecifier)) return;
    const local = clause.name.text;
    const spec = decl.moduleSpecifier.text;
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      this.skip(sf, decl, `import ${local}, * as ...: rewrite by hand`);
      return;
    }
    const others = bindings === undefined ? [] : (bindings as ts.NamedImports).elements.map((e) => e.getText(sf));
    const typeKw = clause.isTypeOnly ? "type " : "";
    const moduleSymbol = this.checker.getSymbolAtLocation(decl.moduleSpecifier);
    const target = moduleSymbol?.declarations?.find(ts.isSourceFile);
    const inProject = target !== undefined && this.targets.has(resolve(target.fileName));
    if (inProject) {
      const name = this.defaultExport(target);
      if (name === null) {
        this.skip(sf, decl, `import ${local} from "${spec}": the module has no nameable default export`);
        return;
      }
      const item = name === local ? name : `${name} as ${local}`;
      this.fix(sf, decl, `import ${local} from "${spec}" -> import { ${item} }`, [{ start: clause.getStart(sf), end: clause.end, text: `${typeKw}{ ${[item, ...others].join(", ")} }` }]);
      return;
    }
    if (spec.startsWith(".")) return;
    // A package: `import http from "node:http"` -> the members the file uses, imported by name.
    const localSymbol = this.checker.getSymbolAtLocation(clause.name);
    const members = new Map<string, true>();
    const accesses: ts.PropertyAccessExpression[] = [];
    let ok = localSymbol !== undefined;
    const scan = (n: ts.Node): void => {
      if (n === clause) return;
      if (ts.isIdentifier(n) && n.text === local && this.checker.getSymbolAtLocation(n) === localSymbol) {
        const p = n.parent;
        if (ts.isPropertyAccessExpression(p) && p.expression === n && !ts.isPartOfTypeNode(p)) {
          accesses.push(p);
          members.set(p.name.text, true);
        } else ok = false;
      }
      ts.forEachChild(n, scan);
    };
    ts.forEachChild(sf, (n) => (n === decl ? undefined : scan(n)));
    const scope = new Set(this.checker.getSymbolsInScope(sf, ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace).filter((s) => s !== localSymbol).map((s) => s.name));
    const names = [...members.keys()];
    if (!ok || names.some((m) => scope.has(m) || others.includes(m))) {
      this.skip(sf, decl, `import ${local} from "${spec}": default import of a package; use named imports by hand`);
      return;
    }
    const edits: Edit[] = accesses.map((a) => ({ start: a.getStart(sf), end: a.end, text: a.name.text }));
    if (names.length === 0 && others.length === 0) edits.push({ start: decl.getStart(sf), end: decl.moduleSpecifier.getStart(sf), text: "import " });
    else edits.push({ start: clause.getStart(sf), end: clause.end, text: `${typeKw}{ ${[...names, ...others].join(", ")} }` });
    this.fix(sf, decl, `import ${local} from "${spec}" -> import { ${names.join(", ")} }`, edits);
  }

  // ─── 6. export * from "package" ─────────────────────────────────────────────

  private exportStar(sf: ts.SourceFile, decl: ts.ExportDeclaration): void {
    if (decl.exportClause !== undefined || decl.moduleSpecifier === undefined || !ts.isStringLiteral(decl.moduleSpecifier)) return;
    const spec = decl.moduleSpecifier.text;
    if (spec.startsWith(".")) return;
    const symbol = this.checker.getSymbolAtLocation(decl.moduleSpecifier);
    if (symbol === undefined) {
      this.skip(sf, decl, `export * from "${spec}": the package does not resolve; list its exports by name`);
      return;
    }
    const values: string[] = [];
    const types: string[] = [];
    for (const e of this.checker.getExportsOfModule(symbol)) {
      if (e.name === "default") continue;
      const real = e.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(e) : e;
      (real.flags & ts.SymbolFlags.Value ? values : types).push(e.name);
    }
    const lines: string[] = [];
    if (values.length > 0) lines.push(`export { ${values.join(", ")} } from "${spec}";`);
    if (types.length > 0) lines.push(`export type { ${types.join(", ")} } from "${spec}";`);
    const start = decl.getStart(sf);
    const lineStart = sf.text.lastIndexOf("\n", start - 1) + 1;
    const indent = sf.text.slice(lineStart, start).replace(/\S.*$/, "");
    this.fix(sf, decl, `export * from "${spec}" -> ${values.length + types.length} named re-exports`, [{ start, end: decl.end, text: lines.join(`\n${indent}`) || `export {};` }]);
  }
}

/** Applies non-overlapping edits (last to first); overlapping ones are left for the next pass. */
export function applyEdits(text: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  let limit = Number.POSITIVE_INFINITY;
  for (const e of sorted) {
    if (e.end > limit) continue;
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    limit = e.start;
  }
  return out;
}

/** Finds (and, with `write`, rewrites) scriptc pitfalls under app/ and config/. Repeats until stable. */
export function fixApp(root: string, options: { write: boolean } = { write: true }): FixReport {
  const fixes: Fix[] = [];
  const unfixable = new Map<string, Fix>();
  const files = new Set<string>();
  for (let round = 0; round < 6; round++) {
    const pass = new Pass(root);
    pass.run();
    for (const u of pass.unfixable) unfixable.set(`${u.file}:${u.line}:${u.message}`, u);
    if (pass.fixes.length === 0) break;
    fixes.push(...pass.fixes);
    if (!options.write) break;
    for (const [file, edits] of pass.edits) {
      const before = readFileSync(file, "utf8");
      const after = applyEdits(before, edits);
      if (after !== before) {
        writeFileSync(file, after);
        files.add(rel(root, file));
      }
    }
  }
  const key = (f: Fix) => `${f.file}:${String(f.line).padStart(6, "0")}`;
  fixes.sort((a, b) => key(a).localeCompare(key(b)));
  return { fixes, unfixable: [...unfixable.values()].sort((a, b) => key(a).localeCompare(key(b))), files: [...files].sort() };
}

