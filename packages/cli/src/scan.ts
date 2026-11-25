import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { CliError, LAYOUT, camel, rel, walk } from "./util";

/** Conventional resource actions: name → [method, path relative to the prefix]. Mirrors @qala/core's App. */
export const RESOURCE: Record<string, [string, string]> = {
  index: ["GET", ""],
  show: ["GET", "/:id"],
  store: ["POST", ""],
  update: ["PATCH", "/:id"],
  destroy: ["DELETE", "/:id"],
};

const VERBS: Record<string, string> = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", del: "DELETE", ws: "WS" };

export type ActionInfo = { name: string; method: string; path: string; line: number };

export type ControllerInfo = {
  /** Absolute file path. */
  file: string;
  /** Path relative to the app root, e.g. `app/http/controllers/admin/users.controller.ts`. */
  relFile: string;
  /** Key in the Api type and manifest, e.g. `adminUsers`. */
  name: string;
  /** Route prefix, e.g. `/admin/users`. */
  prefix: string;
  /** The exported const or class, e.g. `UsersController`. */
  exportName: string;
  /** `controller(...)` call or a class with action fields (wired by the generated DI). */
  kind: "function" | "class";
  /** Inside a `(auth)` folder: every action requires the app's `authenticate`. */
  auth: boolean;
  /** Class controllers: `static middleware = [...]` is declared. */
  staticMiddleware: boolean;
  actions: ActionInfo[];
};

/** Normalises `prefix + path` exactly like @qala/core's `joinPath`. */
export function joinPath(prefix: string, path: string): string {
  const parts = `${prefix}/${path}`.split("/").filter((s) => s !== "");
  return `/${parts.join("/")}`;
}

/** Every `*.controller.ts` under app/http/controllers, parsed. Throws a CliError listing all problems. */
export function scanControllers(root: string): ControllerInfo[] {
  const dir = join(root, LAYOUT.controllers);
  const files = walk(dir, (f) => f.endsWith(".controller.ts"));
  const problems: string[] = [];
  const out: ControllerInfo[] = [];
  for (const file of files) {
    try {
      out.push(parseController(root, dir, file));
    } catch (error) {
      if (error instanceof CliError) problems.push(error.message);
      else throw error;
    }
  }
  const seen = new Map<string, string>();
  for (const c of out) {
    const other = seen.get(c.name);
    if (other !== undefined) problems.push(`${c.relFile}: controller name "${c.name}" clashes with ${other}`);
    seen.set(c.name, c.relFile);
  }
  const routes = new Map<string, string>();
  for (const c of out) {
    for (const a of c.actions) {
      const key = `${a.method} ${normaliseParams(joinPath(c.prefix, a.path))}`;
      const where = `${c.relFile}:${a.line} (${c.name}.${a.name})`;
      const clash = routes.get(key);
      if (clash !== undefined) problems.push(`${where}: route ${key} is also defined at ${clash}`);
      routes.set(key, where);
    }
  }
  if (problems.length > 0) throw new CliError(`Controller problems:\n  ${problems.join("\n  ")}`);
  return out;
}

function normaliseParams(path: string): string {
  return path.replace(/:[^/]+/g, ":");
}

/**
 * Route prefix and name from the file path relative to the controllers folder. Folders in parentheses are
 * groups that do not appear in the URL: `(auth)/tasks.controller.ts` serves `/tasks`; `(auth)` also marks
 * every action of the controllers inside it as requiring authentication.
 */
export function routeIdentity(relToControllers: string): { prefix: string; name: string; auth: boolean } {
  const base = relToControllers.replace(/\.controller\.ts$/, "");
  const all = base.split("/").filter((s) => s !== "");
  const groups = all.filter((s) => /^\(.+\)$/.test(s));
  const segments = all.filter((s) => !/^\(.+\)$/.test(s));
  return { prefix: `/${segments.join("/")}`, name: camel(segments.join(" ")), auth: groups.includes("(auth)") };
}

export function parseController(root: string, controllersDir: string, file: string): ControllerInfo {
  const relFile = rel(root, file);
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const fail = (node: ts.Node | null, message: string): never => {
    const line = node === null ? 1 : source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    throw new CliError(`${relFile}:${line}: ${message}`);
  };
  const classes: ts.ClassDeclaration[] = [];
  for (const stmt of source.statements) {
    if (ts.isClassDeclaration(stmt) && stmt.name !== undefined && (stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false) && stmt.name.text.endsWith("Controller")) classes.push(stmt);
  }
  const found: { name: string; call: ts.CallExpression }[] = [];
  for (const stmt of source.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const exported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (!exported) continue;
    for (const decl of stmt.declarationList.declarations) {
      const init = decl.initializer;
      if (ts.isIdentifier(decl.name) && init !== undefined && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && (init.expression.text === "controller" || init.expression.text === "resource")) {
        found.push({ name: decl.name.text, call: init });
      }
    }
  }
  const identity = routeIdentity(rel(controllersDir, file));
  if (classes.length + found.length > 1) {
    const names = [...classes.map((c) => c.name!.text), ...found.map((f) => f.name)];
    fail(classes[1] ?? found[0]?.call ?? null, `exports ${names.length} controllers (${names.join(", ")}); keep one controller per file`);
  }
  if (classes.length === 1) return parseClassController(root, relFile, file, source, classes[0]!, identity, fail);
  if (found.length === 0) fail(null, "exports no controller: write `export class XController { constructor(private x: XService) {} index = action({}, () => ...) }` or `export const XController = controller({ ...deps }, (deps) => ({ ...actions }))`");
  const { name: exportName, call } = found[0]!;
  if (!exportName.endsWith("Controller")) fail(call, `the controller export "${exportName}" must end with "Controller"`);
  if (ts.isIdentifier(call.expression) && call.expression.text === "resource") return parseResource(source, file, relFile, exportName, call, identity, fail);
  const factory = call.arguments[1];
  if (factory === undefined || !(ts.isArrowFunction(factory) || ts.isFunctionExpression(factory))) {
    return fail(call, "controller() needs a second argument: (deps) => ({ ...actions })");
  }
  const literal = returnedObject(factory);
  if (literal === null) return fail(factory, "the controller factory must return an object literal of actions, e.g. ({ tasks }) => ({ index: action({}, () => tasks.list()) })");
  const actions: ActionInfo[] = [];
  for (const prop of literal.properties) {
    const line = source.getLineAndCharacterOfPosition(prop.getStart(source)).line + 1;
    if (!ts.isPropertyAssignment(prop)) fail(prop, "actions must be written as `name: action(...)` or `name: get(\"/path\", ...)`");
    const assignment = prop as ts.PropertyAssignment;
    const name = propertyName(assignment.name);
    if (name === null) fail(prop, "action names must be plain identifiers");
    actions.push(actionInfo(name!, assignment.initializer, line, fail));
  }
  return { file, relFile, name: identity.name, prefix: identity.prefix, exportName, kind: "function", auth: identity.auth, staticMiddleware: false, actions };
}

type Fail = (node: ts.Node | null, message: string) => never;

const RESOURCE_ACTIONS = ["index", "show", "store", "update", "destroy"];

/** String literals of an array literal option (`only: ["index", "show"]`), or null when absent. */
function stringArray(options: ts.ObjectLiteralExpression | null, key: string, fail: Fail): string[] | null {
  if (options === null) return null;
  for (const prop of options.properties) {
    if (!ts.isPropertyAssignment(prop) || propertyName(prop.name) !== key) continue;
    let value = prop.initializer;
    while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value)) value = value.expression;
    if (!ts.isArrayLiteralExpression(value)) return fail(prop, `resource() option "${key}" must be an array literal of action names`);
    const out: string[] = [];
    for (const el of value.elements) {
      if (!ts.isStringLiteral(el) || !RESOURCE_ACTIONS.includes(el.text)) return fail(el, `resource() option "${key}" lists ${ts.isStringLiteral(el) ? `unknown action "${el.text}"` : "a non-literal"}; it may only list the string literals ${RESOURCE_ACTIONS.join(", ")} (custom actions go in resource()'s third argument)`);
      out.push(el.text);
    }
    return out;
  }
  return null;
}

/**
 * `export const LabelsController = resource(Label, { scope: "projects/:projectId", only: [...] }, (base) => ({ ...extra }))`:
 * the conventional actions it serves (only/except) plus extra actions; a scope nests the URL prefix.
 */
function parseResource(
  source: ts.SourceFile,
  file: string,
  relFile: string,
  exportName: string,
  call: ts.CallExpression,
  identity: { prefix: string; name: string; auth: boolean },
  fail: Fail,
): ControllerInfo {
  const optArg = call.arguments[1];
  const options = optArg !== undefined && ts.isObjectLiteralExpression(optArg) ? optArg : null;
  if (optArg !== undefined && options === null) fail(optArg, "resource() options must be an object literal, so routes can be read at build time");
  let scope = "";
  for (const prop of options?.properties ?? []) {
    if (ts.isPropertyAssignment(prop) && propertyName(prop.name) === "scope") {
      if (!ts.isStringLiteral(prop.initializer) && !ts.isNoSubstitutionTemplateLiteral(prop.initializer)) fail(prop, 'resource() option "scope" must be a string literal, e.g. "projects/:projectId"');
      scope = (prop.initializer as ts.StringLiteral).text;
    }
  }
  const only = stringArray(options, "only", fail);
  const except = stringArray(options, "except", fail) ?? [];
  const actions: ActionInfo[] = [];
  const line = source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1;
  for (const name of only ?? RESOURCE_ACTIONS) {
    if (except.includes(name)) continue;
    const conventional = RESOURCE[name]!;
    actions.push({ name, method: conventional[0], path: conventional[1], line });
  }
  const factory = call.arguments[2];
  if (factory !== undefined) {
    if (!(ts.isArrowFunction(factory) || ts.isFunctionExpression(factory))) return fail(factory, "resource()'s third argument must be (base) => ({ ...actions })");
    const literal = returnedObject(factory);
    if (literal === null) return fail(factory, "resource()'s third argument must return an object literal of actions");
    for (const prop of literal.properties) {
      const at = source.getLineAndCharacterOfPosition(prop.getStart(source)).line + 1;
      if (!ts.isPropertyAssignment(prop)) return fail(prop, 'extra actions must be written as `name: get("/path", ...)`');
      const name = propertyName(prop.name);
      if (name === null) return fail(prop, "action names must be plain identifiers");
      actions.push(actionInfo(name, prop.initializer, at, fail));
    }
  }
  const prefix = scope === "" ? identity.prefix : joinPath(`/${scope}`, identity.prefix);
  return { file, relFile, name: identity.name, prefix, exportName, kind: "function", auth: identity.auth, staticMiddleware: false, actions };
}

/** One action from its initializer: `action(...)` (conventional) or `get/post/…("/path", …)`. */
function actionInfo(name: string, init: ts.Expression, line: number, fail: Fail): ActionInfo {
  if (!ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) return fail(init, `action "${name}" must be action(...) or get/post/put/patch/del/ws("/path", ...)`);
  const helper = init.expression.text;
  if (helper === "action") {
    const conventional = RESOURCE[name];
    if (conventional === undefined) return fail(init, `action() is only for index/show/store/update/destroy; give "${name}" an explicit route, e.g. ${name}: get("/${name}", {}, ...)`);
    return { name, method: conventional[0], path: conventional[1], line };
  }
  const method = VERBS[helper];
  if (method === undefined) return fail(init, `action "${name}" uses ${helper}(); expected action/get/post/put/patch/del/ws`);
  const pathArg = init.arguments[0];
  if (pathArg === undefined || !(ts.isStringLiteral(pathArg) || ts.isNoSubstitutionTemplateLiteral(pathArg))) {
    return fail(init, `${helper}() for "${name}" needs a string-literal path as its first argument`);
  }
  return { name, method, path: pathArg.text, line };
}

/**
 * A class controller: its public instance fields initialised with action helpers are the actions;
 * constructor parameters are injected by the generated providers; `static middleware = [...]` is optional.
 */
function parseClassController(
  root: string,
  relFile: string,
  file: string,
  source: ts.SourceFile,
  cls: ts.ClassDeclaration,
  identity: { prefix: string; name: string; auth: boolean },
  fail: Fail,
): ControllerInfo {
  void root;
  const actions: ActionInfo[] = [];
  let staticMiddleware = false;
  for (const member of cls.members) {
    if (!ts.isPropertyDeclaration(member) || member.initializer === undefined) continue;
    const isStatic = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false;
    const name = propertyName(member.name);
    if (isStatic) {
      if (name === "middleware") staticMiddleware = true;
      continue;
    }
    const hidden = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword) ?? false;
    if (hidden || name === null) continue;
    const init = member.initializer;
    if (!ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) continue;
    const helper = init.expression.text;
    if (helper !== "action" && VERBS[helper] === undefined) continue;
    const line = source.getLineAndCharacterOfPosition(member.getStart(source)).line + 1;
    actions.push(actionInfo(name, init, line, fail));
  }
  if (actions.length === 0) fail(cls, `class ${cls.name!.text} has no action fields; write e.g. index = action({}, () => this.tasks.list())`);
  return { file, relFile, name: identity.name, prefix: identity.prefix, exportName: cls.name!.text, kind: "class", auth: identity.auth, staticMiddleware, actions };
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function returnedObject(fn: ts.ArrowFunction | ts.FunctionExpression): ts.ObjectLiteralExpression | null {
  let body: ts.Node = fn.body;
  if (ts.isBlock(body)) {
    const ret = body.statements.find((s): s is ts.ReturnStatement => ts.isReturnStatement(s));
    if (ret === undefined || ret.expression === undefined) return null;
    body = ret.expression;
  }
  while (ts.isParenthesizedExpression(body) || ts.isAsExpression(body) || ts.isSatisfiesExpression(body)) body = body.expression;
  return ts.isObjectLiteralExpression(body) ? body : null;
}

export type RouteRow = { method: string; path: string; controller: string; action: string; file: string };

export function routeTable(controllers: ControllerInfo[]): RouteRow[] {
  const rows: RouteRow[] = [];
  for (const c of controllers) {
    for (const a of c.actions) rows.push({ method: a.method, path: joinPath(c.prefix, a.path), controller: c.name, action: a.name, file: `${c.relFile}:${a.line}` });
  }
  return rows;
}
