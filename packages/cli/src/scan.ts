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

const VERBS: Record<string, string> = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", del: "DELETE" };

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
  /** The exported const, e.g. `UsersController`. */
  exportName: string;
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

/** Route prefix and name from the file path relative to the controllers folder. */
export function routeIdentity(relToControllers: string): { prefix: string; name: string } {
  const base = relToControllers.replace(/\.controller\.ts$/, "");
  const segments = base.split("/").filter((s) => s !== "");
  return { prefix: `/${segments.join("/")}`, name: camel(segments.join(" ")) };
}

export function parseController(root: string, controllersDir: string, file: string): ControllerInfo {
  const relFile = rel(root, file);
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const fail = (node: ts.Node | null, message: string): never => {
    const line = node === null ? 1 : source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    throw new CliError(`${relFile}:${line}: ${message}`);
  };
  const found: { name: string; call: ts.CallExpression }[] = [];
  for (const stmt of source.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const exported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (!exported) continue;
    for (const decl of stmt.declarationList.declarations) {
      const init = decl.initializer;
      if (ts.isIdentifier(decl.name) && init !== undefined && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "controller") {
        found.push({ name: decl.name.text, call: init });
      }
    }
  }
  if (found.length === 0) fail(null, "exports no controller: write `export const XController = controller({ ...deps }, (deps) => ({ ...actions }))`");
  if (found.length > 1) fail(found[1]!.call, `exports ${found.length} controllers (${found.map((f) => f.name).join(", ")}); keep one controller per file`);
  const { name: exportName, call } = found[0]!;
  if (!exportName.endsWith("Controller")) fail(call, `the controller export "${exportName}" must end with "Controller"`);
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
    const init = assignment.initializer;
    if (!ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) return fail(init, `action "${name}" must be action(...) or get/post/put/patch/del("/path", ...)`);
    const helper = init.expression.text;
    if (helper === "action") {
      const conventional = RESOURCE[name!];
      if (conventional === undefined) fail(init, `action() is only for index/show/store/update/destroy; give "${name}" an explicit route, e.g. ${name}: get("/${name}", {}, ...)`);
      actions.push({ name: name!, method: conventional![0], path: conventional![1], line });
      continue;
    }
    const method = VERBS[helper];
    if (method === undefined) fail(init, `action "${name}" uses ${helper}(); expected action/get/post/put/patch/del`);
    const pathArg = init.arguments[0];
    if (pathArg === undefined || !(ts.isStringLiteral(pathArg) || ts.isNoSubstitutionTemplateLiteral(pathArg))) {
      fail(init, `${helper}() for "${name}" needs a string-literal path as its first argument`);
    }
    actions.push({ name: name!, method: method!, path: (pathArg as ts.StringLiteral).text, line });
  }
  const { prefix, name } = routeIdentity(rel(controllersDir, file));
  return { file, relFile, name, prefix, exportName, actions };
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
