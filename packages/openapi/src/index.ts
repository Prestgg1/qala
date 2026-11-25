/**
 * OpenAPI 3.1 documents from a Qala app, built at generation time (on Bun) from the app's registered
 * routes, the input schemas of its actions and the models of its `resource()` controllers.
 */
import type { App, ControllerDef, ControllerEntry, ModelDef, Route, SchemaNode } from "@qala/core";

/** A JSON Schema (2020-12, the dialect of OpenAPI 3.1) or any other JSON object of the document. */
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export type OpenApiOptions = {
  /** `info.title` (default "Qala API"). */
  title?: string;
  /** `info.version` (default "0.0.0"). */
  version?: string;
  description?: string;
  /** `servers[].url` entries. */
  servers?: string[];
  /**
   * The security scheme of routes with `auth` (default `{ type: "http", scheme: "bearer" }`): Qala's
   * `authenticate` hook is app code, so the scheme cannot be inferred.
   */
  securityScheme?: JsonObject;
  /** Controller names to leave out (the generated `/openapi.json` route is always left out). */
  exclude?: string[];
};

/** The controller name of the generated `/openapi.json` route. */
export const OPENAPI_CONTROLLER = "qalaOpenapi";

const ERROR_REF = { $ref: "#/components/schemas/Error" };
const VALIDATION_REF = { $ref: "#/components/schemas/ValidationError" };
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** `/tasks/:id/comments` → `/tasks/{id}/comments`. */
export function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

/** Path parameter names in order. */
function pathParams(path: string): string[] {
  const out: string[] = [];
  for (const m of path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) out.push(m[1]!);
  return out;
}

/** "Project label" → "ProjectLabel" (a component name). */
function componentName(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== "")
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");
}

function literalValue(text: string, type: string): JsonValue {
  if (type === "number") return Number(text);
  if (type === "boolean") return text === "true";
  return text;
}

/** The JSON Schema of a schema's value, without its nullability (see `toJsonSchema`). */
function baseSchema(node: SchemaNode): JsonObject {
  const r = node.rules;
  switch (node.kind) {
    case "string": {
      const s: JsonObject = { type: "string" };
      if (r.hasMin) s["minLength"] = r.min;
      if (r.hasMax) s["maxLength"] = r.max;
      if (r.pattern !== "") s["pattern"] = r.pattern;
      return s;
    }
    case "uuid":
      return { type: "string", format: "uuid" };
    case "email":
      return { type: "string", format: "email" };
    case "datetime":
      // Validation accepts an ISO date or date-time; responses carry full date-times.
      return { type: "string", format: "date-time" };
    case "number":
    case "integer": {
      const s: JsonObject = { type: node.kind };
      if (r.hasMin) s["minimum"] = r.min;
      if (r.hasMax) s["maximum"] = r.max;
      return s;
    }
    case "boolean":
      return { type: "boolean" };
    case "enum":
    case "literal": {
      const values: JsonValue[] = r.values.map((v, i) => literalValue(v, r.valueTypes[i] ?? "string"));
      const types = [...new Set(r.valueTypes)];
      const s: JsonObject = { enum: values };
      if (types.length === 1) s["type"] = types[0]!;
      return s;
    }
    case "array": {
      const s: JsonObject = { type: "array", items: r.item === null ? {} : toJsonSchema(r.item) };
      if (r.hasMin) s["minItems"] = r.min;
      if (r.hasMax) s["maxItems"] = r.max;
      return s;
    }
    case "object": {
      const properties: JsonObject = {};
      const required: string[] = [];
      for (let i = 0; i < node.keys.length; i++) {
        const field = node.fields[i]!;
        properties[node.keys[i]!] = toJsonSchema(field);
        if (!field.optional) required.push(node.keys[i]!);
      }
      const s: JsonObject = { type: "object", properties };
      if (required.length > 0) s["required"] = required;
      return s;
    }
    default:
      return {};
  }
}

/** Whether the schema accepts `null` (`t.nullable(...)`, `.nullable()`). */
function acceptsNull(node: SchemaNode): boolean {
  if (node.column.isNullable) return true;
  // A hand-written check may accept null too; probing it is cheap and exact.
  if (node.kind === "unknown") return false;
  const issues: { path: string; message: string }[] = [];
  node.check(null, "", issues, false);
  return issues.length === 0;
}

/** A Qala schema as JSON Schema: types, formats, lengths, bounds, patterns, enums, array items, object fields. */
export function toJsonSchema(node: SchemaNode): JsonObject {
  const s = baseSchema(node);
  if (!acceptsNull(node)) return s;
  const type = s["type"];
  if (typeof type === "string") s["type"] = [type, "null"];
  if (Array.isArray(s["enum"])) (s["enum"] as JsonValue[]).push(null);
  if (type === undefined && s["enum"] === undefined) return Object.keys(s).length === 0 ? s : { anyOf: [s, { type: "null" }] };
  return s;
}

/** The row schema of a model: every field, required unless declared `t.optional`. */
export function modelSchema(model: ModelDef): JsonObject {
  const properties: JsonObject = {};
  const required: string[] = [];
  for (let i = 0; i < model.keys.length; i++) {
    const field = model.fields[i]!;
    const s = toJsonSchema(field);
    if (field.column.isPrimary) s["readOnly"] = true;
    properties[model.keys[i]!] = s;
    if (!field.optional) required.push(model.keys[i]!);
  }
  return { type: "object", properties, required };
}

function errorComponents(): JsonObject {
  const envelope = (details: JsonObject): JsonObject => ({
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["status", "code", "message", "details"],
        properties: {
          status: { type: "integer" },
          code: { type: "string" },
          message: { type: "string" },
          details: details,
        },
      },
    },
  });
  return {
    Error: { ...envelope({ description: "Error specific data, or null" }), description: "The error envelope every Qala error response uses." },
    ValidationError: {
      ...envelope({
        type: "array",
        items: { type: "object", required: ["path", "message"], properties: { path: { type: "string" }, message: { type: "string" } } },
      }),
      description: "422 validation_failed: one entry per invalid field (`path` like `title` or `items[0].qty`).",
    },
  };
}

function errorResponse(description: string, validation = false): JsonObject {
  return { description, content: { "application/json": { schema: validation ? VALIDATION_REF : ERROR_REF } } };
}

function jsonResponse(description: string, schema: JsonObject): JsonObject {
  return { description, content: { "application/json": { schema } } };
}

/** Query/path parameters of an object schema. */
function parametersOf(node: SchemaNode | null, where: "query" | "path", names: string[]): JsonObject[] {
  const out: JsonObject[] = [];
  const seen = new Set<string>();
  if (node !== null && node.kind === "object") {
    for (let i = 0; i < node.keys.length; i++) {
      const name = node.keys[i]!;
      if (where === "path" && !names.includes(name)) continue;
      const field = node.fields[i]!;
      seen.add(name);
      out.push({ name, in: where, required: where === "path" || !field.optional, schema: toJsonSchema(field) });
    }
  }
  if (where === "path") for (const name of names) if (!seen.has(name)) out.push({ name, in: "path", required: true, schema: { type: "string" } });
  if (where === "path") out.sort((a, b) => names.indexOf(a["name"] as string) - names.indexOf(b["name"] as string));
  return out;
}

function resourceQuery(meta: NonNullable<ControllerDef["resource"]>): JsonObject[] {
  const model = meta.model;
  const out: JsonObject[] = [
    { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1, default: 1 } },
    { name: "pageSize", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: meta.maxPageSize, default: meta.pageSize } },
    {
      name: "sort",
      in: "query",
      required: false,
      description: "A field, optionally prefixed with `-` for descending order.",
      schema: { type: "string", enum: [...model.keys, ...model.keys.map((k) => `-${k}`)] },
    },
  ];
  for (const key of meta.filters) {
    const field = model.fields[model.indexOf(key)]!;
    const schema = baseSchema(field);
    out.push({ name: key, in: "query", required: false, description: "Filter by equality.", schema });
  }
  return out;
}

function pageSchema(item: JsonObject): JsonObject {
  return {
    type: "object",
    required: ["data", "meta"],
    properties: {
      data: { type: "array", items: item },
      meta: {
        type: "object",
        required: ["page", "pageSize", "total", "pages"],
        properties: { page: { type: "integer" }, pageSize: { type: "integer" }, total: { type: "integer" }, pages: { type: "integer" } },
      },
    },
  };
}

/** The request body of an action: JSON, or multipart when it accepts uploads. */
function requestBody(route: Route): JsonObject | null {
  const def = route.def;
  if (def.body === null && def.multipart === null) return null;
  const schema = def.body === null ? {} : toJsonSchema(def.body);
  if (def.multipart === null) return { required: true, content: { "application/json": { schema } } };
  const form: JsonObject = def.body === null ? { type: "object" } : { ...schema };
  form["additionalProperties"] = { type: "string", format: "binary" };
  return { required: true, content: { "multipart/form-data": { schema: form }, "application/json": { schema } } };
}

/**
 * Builds the OpenAPI 3.1 document of `app`. `controllers` are the entries the app was created with
 * (`appOptions.controllers`): they carry the `resource()` models used for response schemas.
 */
export function buildOpenApi(app: App, controllers: ControllerEntry[], options: OpenApiOptions = {}): JsonObject {
  const byName = new Map<string, ControllerDef>();
  for (const entry of controllers) byName.set(entry.name, entry.controller);
  const exclude = new Set([OPENAPI_CONTROLLER, ...(options.exclude ?? [])]);
  const schemas: JsonObject = errorComponents();
  const paths: JsonObject = {};
  const tags = new Set<string>();
  let usesAuth = false;

  for (const route of app.routes) {
    if (!METHODS.has(route.method) || exclude.has(route.controller)) continue;
    const def = route.def;
    const meta = byName.get(route.controller)?.resource ?? null;
    const conventional = def.method === "";
    const names = pathParams(route.path);

    // Response body schema: a resource's model; otherwise not inferred (handler return types are erased).
    let modelRef: JsonObject | null = null;
    if (meta !== null && conventional) {
      const name = componentName(route.resource === "" ? meta.model.table : route.resource);
      if (schemas[name] === undefined) schemas[name] = modelSchema(meta.model);
      modelRef = { $ref: `#/components/schemas/${name}` };
    }

    const parameters = [...parametersOf(def.params, "path", names), ...(meta !== null && conventional && route.action === "index" ? resourceQuery(meta) : parametersOf(def.query, "query", []))];
    const responses: JsonObject = {};
    const notInferred: JsonObject = { description: "Not inferred: the handler's return type is not known at run time." };
    const action = conventional ? route.action : "";
    if (action === "store") responses["201"] = jsonResponse("Created", modelRef ?? notInferred);
    else if (action === "destroy") responses["204"] = { description: "Deleted (no content)" };
    else if (action === "index" && modelRef !== null) responses["200"] = jsonResponse("One page of rows", pageSchema(modelRef));
    else responses["200"] = jsonResponse("OK", modelRef ?? notInferred);
    if (def.params !== null || def.query !== null || def.body !== null || (meta !== null && conventional)) responses["422"] = errorResponse("Invalid input (validation_failed) or a broken domain rule", true);
    if (route.auth === "required") responses["401"] = errorResponse("Not signed in (unauthorized)");
    if (meta !== null && meta.hasPolicy && conventional) responses["403"] = errorResponse("Refused by the resource policy (forbidden)");
    if (names.length > 0) responses["404"] = errorResponse(route.resource === "" ? "Not found" : `${route.resource} not found`);
    responses["default"] = errorResponse("Any other error, in the standard error envelope");

    const op: JsonObject = { operationId: `${route.controller}.${route.action}`, tags: [route.controller] };
    tags.add(route.controller);
    if (parameters.length > 0) op["parameters"] = parameters;
    const body = requestBody(route);
    if (body !== null) op["requestBody"] = body;
    op["responses"] = responses;
    if (route.auth === "required") {
      op["security"] = [{ bearerAuth: [] }];
      usesAuth = true;
    } else if (route.auth === "optional") {
      op["security"] = [{ bearerAuth: [] }, {}];
      usesAuth = true;
    }

    const key = openApiPath(route.path);
    const item = (paths[key] as JsonObject | undefined) ?? {};
    item[route.method.toLowerCase()] = op;
    paths[key] = item;
  }

  const info: JsonObject = { title: options.title ?? "Qala API", version: options.version ?? "0.0.0" };
  if (options.description !== undefined) info["description"] = options.description;
  const doc: JsonObject = { openapi: "3.1.0", info };
  if (options.servers !== undefined && options.servers.length > 0) doc["servers"] = options.servers.map((url) => ({ url }));
  doc["tags"] = [...tags].map((name) => ({ name }));
  doc["paths"] = paths;
  const components: JsonObject = { schemas };
  if (usesAuth) components["securitySchemes"] = { bearerAuth: options.securityScheme ?? { type: "http", scheme: "bearer" } };
  doc["components"] = components;
  return doc;
}

const PLAIN_KEY = /^[A-Za-z_$][A-Za-z0-9_$.\-/{}]*$/;

function yamlKey(key: string): string {
  return PLAIN_KEY.test(key) && !/^(true|false|null|yes|no|on|off|~)$/i.test(key) ? key : JSON.stringify(key);
}

function yamlScalar(value: JsonValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function isContainer(v: JsonValue): v is JsonValue[] | JsonObject {
  return v !== null && typeof v === "object" && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0);
}

function inline(v: JsonValue): string {
  if (Array.isArray(v)) return "[]";
  if (v !== null && typeof v === "object") return "{}";
  return yamlScalar(v);
}

function yamlLines(v: JsonValue[] | JsonObject, pad: string): string[] {
  const out: string[] = [];
  if (Array.isArray(v)) {
    for (const item of v) {
      if (!isContainer(item)) {
        out.push(`${pad}- ${inline(item)}`);
        continue;
      }
      const sub = yamlLines(item, `${pad}  `);
      out.push(`${pad}- ${sub[0]!.slice(pad.length + 2)}`, ...sub.slice(1));
    }
    return out;
  }
  for (const key of Object.keys(v)) {
    const value = v[key]!;
    if (isContainer(value)) out.push(`${pad}${yamlKey(key)}:`, ...yamlLines(value, `${pad}  `));
    else out.push(`${pad}${yamlKey(key)}: ${inline(value)}`);
  }
  return out;
}

/** A JSON document as YAML (block style; strings double-quoted so no value is misread). */
export function toYaml(value: JsonObject): string {
  return `${yamlLines(value, "").join("\n")}\n`;
}
