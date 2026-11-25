import { describe, expect, test } from "bun:test";
import { action, controller, createApp, Database, del, get, model, Policy, post, provide, resource, t, type ControllerEntry } from "@qala/core";
import { buildOpenApi, openApiPath, toJsonSchema, toYaml, type JsonObject } from "@qala/openapi";

const Board = model("oa_boards", { id: t.uuid().primary(), name: t.string({ min: 1, max: 80 }) });
const Label = model("oa_labels", {
  id: t.uuid().primary(),
  boardId: t.uuid().references(Board),
  name: t.string({ min: 1, max: 40 }),
  color: t.enum(["red", "green"]).default("red"),
  note: t.string().nullable(),
  createdAt: t.datetime().now(),
});

class LabelPolicy extends Policy {}

const Item = t.object({ sku: t.string({ pattern: /^[A-Z]{3}\d+$/ }), qty: t.integer({ min: 1 }) });
const Orders = controller({}, () => ({
  index: action({ query: { status: t.optional(t.literal(["open", 1, true])), limit: t.optional(t.integer({ max: 50 })) } }, () => [] as string[]),
  store: action({ body: t.object({ items: t.array(Item, { min: 1 }), email: t.email(), meta: t.optional(t.unknown()) }), auth: true }, () => ({ ok: true })),
  receipt: get("/:orderId/receipt", { auth: "optional" }, () => "r"),
  upload: post("/:orderId/files", { params: { orderId: t.uuid() }, files: { maxFiles: 2 }, body: t.object({ title: t.string() }) }, () => undefined),
  purge: del("/purge", {}, () => undefined),
}));

const controllers: ControllerEntry[] = [
  { name: "labels", prefix: "/boards/:boardId/labels", controller: resource(Label, { scope: "boards/:boardId", policy: new LabelPolicy(), filters: ["color"], auth: true, name: "Label" }) },
  { name: "boards", prefix: "/boards", controller: resource(Board, { only: ["index", "show"] }) },
  { name: "orders", prefix: "/orders", controller: Orders },
  { name: "qalaOpenapi", prefix: "/openapi.json", controller: controller({}, () => ({ index: action({}, () => "{}") })) },
];
// The database is never contacted: building the app only resolves the providers.
const app = createApp({ controllers, providers: [provide(Database, () => new Database("postgres://nobody@127.0.0.1:1/none"))] });
const doc = buildOpenApi(app, controllers, { title: "Shop", version: "1.2.3", servers: ["https://api.example.com"] });

type Op = { operationId: string; parameters?: JsonObject[]; requestBody?: { content: Record<string, { schema: JsonObject }> }; responses: Record<string, JsonObject>; security?: JsonObject[] };
const paths = doc["paths"] as Record<string, Record<string, Op>>;
const op = (path: string, method: string): Op => {
  const found = paths[path]?.[method];
  if (found === undefined) throw new Error(`no ${method} ${path}`);
  return found;
};
const schemas = (doc["components"] as { schemas: Record<string, JsonObject> }).schemas;

describe("buildOpenApi", () => {
  test("document header", () => {
    expect(doc["openapi"]).toBe("3.1.0");
    expect(doc["info"]).toEqual({ title: "Shop", version: "1.2.3" });
    expect(doc["servers"]).toEqual([{ url: "https://api.example.com" }]);
  });

  test("paths: :params become {params}; the generated /openapi.json route is left out", () => {
    expect(openApiPath("/a/:b/c/:d_e")).toBe("/a/{b}/c/{d_e}");
    expect(Object.keys(paths).sort()).toEqual(["/boards", "/boards/{boardId}/labels", "/boards/{boardId}/labels/{id}", "/boards/{id}", "/orders", "/orders/purge", "/orders/{orderId}/files", "/orders/{orderId}/receipt"]);
    // Conventional update is documented once, as PATCH (PUT is an alias).
    expect(Object.keys(paths["/boards/{boardId}/labels/{id}"]!).sort()).toEqual(["delete", "get", "patch"]);
    // Every path parameter is declared, typed from its schema or as a string.
    expect(op("/boards/{boardId}/labels/{id}", "get").parameters?.map((p) => [p["name"], p["in"], p["required"], p["schema"]])).toEqual([
      ["boardId", "path", true, { type: "string", format: "uuid" }],
      ["id", "path", true, { type: "string", format: "uuid" }],
    ]);
    expect(op("/orders/{orderId}/receipt", "get").parameters).toEqual([{ name: "orderId", in: "path", required: true, schema: { type: "string" } }]);
  });

  test("resource: model component, conventional statuses, policy and auth", () => {
    expect(schemas["Label"]).toEqual({
      type: "object",
      properties: {
        id: { type: "string", format: "uuid", readOnly: true },
        boardId: { type: "string", format: "uuid" },
        name: { type: "string", minLength: 1, maxLength: 40 },
        color: { enum: ["red", "green"], type: "string" },
        note: { type: ["string", "null"] },
        createdAt: { type: "string", format: "date-time" },
      },
      required: ["id", "boardId", "name", "color", "note", "createdAt"],
    });
    const store = op("/boards/{boardId}/labels", "post");
    expect(Object.keys(store.responses).sort()).toEqual(["201", "401", "403", "404", "422", "default"]);
    expect(store.responses["201"]).toEqual({ description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/Label" } } } });
    expect(store.security).toEqual([{ bearerAuth: [] }]);
    // Scope fields come from the URL, so the body does not list boardId.
    const body = store.requestBody!.content["application/json"]!.schema;
    expect(Object.keys(body["properties"] as JsonObject)).toEqual(["id", "name", "color", "note", "createdAt"]);
    expect(body["required"]).toEqual(["name"]);
    expect(op("/boards/{boardId}/labels/{id}", "delete").responses["204"]).toEqual({ description: "Deleted (no content)" });
    expect(op("/boards/{boardId}/labels/{id}", "get").responses["404"]!["description"]).toBe("Label not found");
    const index = op("/boards/{boardId}/labels", "get");
    expect(index.parameters?.map((p) => p["name"])).toEqual(["boardId", "page", "pageSize", "sort", "color"]);
    const page = (index.responses["200"]!["content"] as Record<string, { schema: JsonObject }>)["application/json"]!.schema;
    expect((page["properties"] as Record<string, JsonObject>)["data"]).toEqual({ type: "array", items: { $ref: "#/components/schemas/Label" } });
    // Public read-only resource: no security, no 401/403.
    expect(op("/boards", "get").security).toBeUndefined();
    expect(Object.keys(op("/boards/{id}", "get").responses).sort()).toEqual(["200", "404", "422", "default"]);
    // Named after the resource: "Oa board" (from the table) → OaBoard.
    expect(schemas["OaBoard"]).toBeDefined();
  });

  test("custom actions: input schemas in, response bodies not inferred", () => {
    const index = op("/orders", "get");
    expect(index.parameters).toEqual([
      { name: "status", in: "query", required: false, schema: { enum: ["open", 1, true] } },
      { name: "limit", in: "query", required: false, schema: { type: "integer", maximum: 50 } },
    ]);
    expect(index.responses["200"]!["content"]).toEqual({ "application/json": { schema: { description: "Not inferred: the handler's return type is not known at run time." } } });
    const store = op("/orders", "post");
    expect(store.requestBody!.content["application/json"]!.schema).toEqual({
      type: "object",
      properties: {
        items: { type: "array", minItems: 1, items: { type: "object", properties: { sku: { type: "string", pattern: "^[A-Z]{3}\\d+$" }, qty: { type: "integer", minimum: 1 } }, required: ["sku", "qty"] } },
        email: { type: "string", format: "email" },
        meta: {},
      },
      required: ["items", "email"],
    });
    expect(Object.keys(store.responses).sort()).toEqual(["201", "401", "422", "default"]);
    expect(op("/orders/{orderId}/receipt", "get").security).toEqual([{ bearerAuth: [] }, {}]);
    // Validation errors use the ValidationError component; other errors the plain envelope.
    expect(store.responses["422"]!["content"]).toEqual({ "application/json": { schema: { $ref: "#/components/schemas/ValidationError" } } });
    expect(store.responses["401"]!["content"]).toEqual({ "application/json": { schema: { $ref: "#/components/schemas/Error" } } });
    // No inputs: no 422.
    expect(Object.keys(op("/orders/purge", "delete").responses).sort()).toEqual(["200", "default"]);
  });

  test("multipart uploads", () => {
    const upload = op("/orders/{orderId}/files", "post");
    expect(upload.requestBody!.content["multipart/form-data"]!.schema).toEqual({ type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: { type: "string", format: "binary" } });
  });

  test("error envelope components", () => {
    const error = schemas["Error"]!["properties"] as Record<string, JsonObject>;
    expect((error["error"]!["required"] as string[])).toEqual(["status", "code", "message", "details"]);
    const details = ((schemas["ValidationError"]!["properties"] as Record<string, JsonObject>)["error"]!["properties"] as Record<string, JsonObject>)["details"];
    expect(details).toEqual({ type: "array", items: { type: "object", required: ["path", "message"], properties: { path: { type: "string" }, message: { type: "string" } } } });
    expect((doc["components"] as JsonObject)["securitySchemes"]).toEqual({ bearerAuth: { type: "http", scheme: "bearer" } });
  });

  test("structurally valid: unique operationIds, every $ref resolves, responses everywhere", () => {
    const ids = new Set<string>();
    for (const item of Object.values(paths)) {
      for (const o of Object.values(item)) {
        expect(ids.has(o.operationId)).toBe(false);
        ids.add(o.operationId);
        expect(Object.keys(o.responses).length).toBeGreaterThan(0);
        for (const [code, r] of Object.entries(o.responses)) {
          expect(code === "default" || /^[1-5]\d\d$/.test(code)).toBe(true);
          expect(typeof r["description"]).toBe("string");
        }
      }
    }
    const refs = JSON.stringify(doc).match(/"\$ref":"[^"]+"/g) ?? [];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const name = /#\/components\/schemas\/(.+)"$/.exec(ref)?.[1];
      expect(name !== undefined && schemas[name] !== undefined).toBe(true);
    }
    // Path templates match their declared path parameters.
    for (const [path, item] of Object.entries(paths)) {
      const names = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).sort();
      for (const o of Object.values(item)) expect((o.parameters ?? []).filter((p) => p["in"] === "path").map((p) => p["name"]).sort()).toEqual(names);
    }
  });
});

describe("toJsonSchema", () => {
  test("nullable and optional", () => {
    expect(toJsonSchema(t.nullable(t.integer({ min: 0 })))).toEqual({ type: ["integer", "null"], minimum: 0 });
    expect(toJsonSchema(t.nullable(t.enum(["a"])))).toEqual({ enum: ["a", null], type: ["string", "null"] });
    expect(toJsonSchema(t.optional(t.string({ max: 3 })))).toEqual({ type: "string", maxLength: 3 });
    expect(toJsonSchema(t.unknown())).toEqual({});
    expect(toJsonSchema(t.array(t.nullable(t.boolean()), { max: 2 }))).toEqual({ type: "array", items: { type: ["boolean", "null"] }, maxItems: 2 });
  });
});

describe("toYaml", () => {
  test("block YAML with quoted strings", () => {
    expect(toYaml({ openapi: "3.1.0", list: [{ a: 1, b: [true, null] }, "x"], empty: {}, none: [], "a b": "y: z" })).toBe(
      ['openapi: "3.1.0"', "list:", "  - a: 1", "    b:", "      - true", "      - null", '  - "x"', "empty: {}", "none: []", '"a b": "y: z"', ""].join("\n"),
    );
  });
});
