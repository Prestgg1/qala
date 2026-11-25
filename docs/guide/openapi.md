# OpenAPI

`@qala/openapi` turns a Qala app into an [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0) document: every
route, its parameters and request body (from the action's schemas), authentication, the conventional status codes
and the standard error envelope. Generation runs on Bun at build time; the native binary only ever serves a
pre-generated string.

```sh
qala openapi                       # writes openapi.json
qala openapi --out api/spec.json
qala openapi --yaml                # writes openapi.yaml
qala openapi --yaml --out spec.yaml
```

`qala openapi` runs `qala generate` first, then loads the generated app (`.qala/app.gen.ts`) in a separate Bun
process and walks its routes. Loading the app imports its modules and resolves its providers, but nothing listens
and the database is not contacted (connections are lazy).

## Opting in: `.qala/openapi.json` and `GET /openapi.json`

Add a `qala.openapi` entry to the app's `package.json`:

```json
{
  "name": "tasks",
  "qala": {
    "openapi": { "title": "Tasks API", "serve": true }
  }
}
```

- `"openapi": true` (or an object) — `qala generate` (and therefore `qala dev` and `qala build`) also writes
  `.qala/openapi.json`.
- `"serve": true` — additionally writes `.qala/openapi.gen.ts`, which holds the document as a string constant, and
  the generated `main.ts` registers `GET /openapi.json` serving it. The route is a plain string reply, so it compiles
  with scriptc like any other; the example app's end-to-end suite checks it against the native binary. The route is
  left out of the document itself.

Options (all optional):

| option | default | |
|---|---|---|
| `title` | `package.json` `name` | `info.title` |
| `version` | `package.json` `version` | `info.version` |
| `description` | `package.json` `description` | `info.description` |
| `servers` | none | `["https://api.example.com"]` → `servers[].url` |
| `securityScheme` | `{ "type": "http", "scheme": "bearer" }` | the scheme of routes with `auth` |
| `exclude` | `[]` | controller names to leave out |
| `serve` | `false` | serve `GET /openapi.json` |

## From code

```ts
import { createApp } from "@qala/core";
import { buildOpenApi, toYaml } from "@qala/openapi";
import { appOptions } from "./.qala/app.gen";

const doc = buildOpenApi(createApp(appOptions), appOptions.controllers, { title: "Tasks API", version: "1.0.0" });
await Bun.write("openapi.yaml", toYaml(doc));
```

`toJsonSchema(schema)` converts one `t.*` schema; `generateOpenApi(root)` from `@qala/openapi/load` does what the
CLI does. These run on Bun only — keep them out of code the native binary compiles.

## What is inferred

| | |
|---|---|
| Paths and methods | every registered route; `:id` becomes `{id}`. A conventional `update` is documented as `PATCH` (its `PUT` alias is not listed). |
| Operation ids and tags | `controller.action` (`tasks.show`), tagged with the controller name |
| Path parameters | from `params` schemas; parameters without a schema are `string` |
| Query parameters | from `query` shapes, `required` unless `t.optional`; a resource's `index` gets `page`, `pageSize`, `sort` and its `filters` |
| Request bodies | from `body` schemas as JSON; actions with `files` also list `multipart/form-data` (text fields from `body`, files as `binary`) |
| JSON Schema | `t.string` (`minLength`/`maxLength`/`pattern`), `t.uuid`/`t.email`/`t.datetime` (`format`), `t.integer`/`t.number` (`minimum`/`maximum`), `t.boolean`, `t.enum`/`t.literal` (`enum`), `t.array` (`items`, `minItems`/`maxItems`), `t.object` (`properties`, `required`), `t.nullable`/`.nullable()` (`"null"` added to `type`), `t.optional` (left out of `required`), `t.unknown` (`{}`) |
| Authentication | `auth: true`, `(auth)` folders and `resource(…, { auth: true })` → `security: [{ bearerAuth: [] }]` and a 401; `auth: "optional"` → bearer or anonymous |
| Success status | conventional `store` → **201**, conventional `destroy` → **204**, everything else **200** |
| Error statuses | **422** (`ValidationError` schema) when the action has input schemas; **401** with `auth`; **403** for a resource with a `policy`; **404** for routes with path parameters (a `null` result, or a resource row that does not exist); `default` → the error envelope |
| Response bodies of `resource()` | the model as a component (`Label`): every field, `required` unless `t.optional`, nullable columns as `[type, "null"]`, primary key `readOnly`; `index` returns `{ data: Label[], meta: { page, pageSize, total, pages } }` |

Every error response uses the [standard envelope](./errors.md):

```json
{ "error": { "status": 404, "code": "not_found", "message": "Task not found", "details": null } }
```

documented as `components.schemas.Error`, and `ValidationError` for 422 (`details` is `[{ path, message }]`).

## What is not inferred

- **Response bodies of hand-written actions.** A handler's return type exists only for the TypeScript compiler; at
  run time an action is a function. Those responses are documented with an empty schema and the description
  "Not inferred". Use `resource()` where it fits, or post-process the document (it is plain JSON).
- **Which handlers return `undefined` or `null`.** 204 is documented only for conventional `destroy`, and 404 for
  any route with path parameters, whether or not the handler can actually return `null`.
- **The authentication scheme.** `authenticate` in `app/auth.ts` is app code; the document assumes a bearer token
  unless `securityScheme` says otherwise (for example `{ "type": "apiKey", "in": "header", "name": "x-api-key" }`).
- **Errors the app throws itself** (`DomainError`s, `HttpError`s, an `onError` handler's replies, a 409 for a
  unique violation): they are covered only by the `default` response. Global middleware (CORS, rate limits) is not
  described.
- **Custom messages, coercion and refinements**: the JSON Schema says what is accepted, not how query strings are
  coerced. `t.datetime()` is documented as `date-time` although a plain date is also accepted.
- **WebSocket routes** (`ws(...)`) and streaming responses are not part of the document.
