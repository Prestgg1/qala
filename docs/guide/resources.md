# Resources

`resource(Model, options)` is a complete CRUD controller in one line, validated by the model itself.

```ts
// app/http/controllers/labels.controller.ts
import { resource } from "@qala/core";
import { Label } from "../../domain/label";
import { LabelPolicy } from "../policies/label.policy";

export const LabelsController = resource(Label, {
  scope: "projects/:projectId",
  policy: new LabelPolicy(),
  filters: ["color"],
  auth: true,
});
```

| route | does |
|---|---|
| `GET /projects/:projectId/labels` | one page of the project's labels |
| `GET /projects/:projectId/labels/:id` | one label (404 if missing or in another project) |
| `POST /projects/:projectId/labels` | validates with `Label.createSchema`, fills `projectId` from the URL → **201** |
| `PATCH /projects/:projectId/labels/:id` | validates with `Label.updateSchema` → the updated row |
| `DELETE /projects/:projectId/labels/:id` | **204** |

The `:id` and scope parameters are validated against the model's field types (a malformed UUID is 422, not a database
error). Missing rows are 404 `"Label not found"`.

## Before / after

Before: a model, a repository, a service, five actions with schemas, pagination and a policy check in each:

```ts
export const LabelsController = controller({ labels: LabelService }, ({ labels }) => ({
  index: action({ params: { projectId: t.uuid() }, query: { page: t.optional(t.integer()) } }, ({ params, query }) => labels.page(params.projectId, query.page ?? 1)),
  show: action({ params: { projectId: t.uuid(), id: t.uuid() } }, ({ params }) => labels.find(params.projectId, params.id)),
  store: action({ params: { projectId: t.uuid() }, body: NewLabel }, async ({ params, body }) => created(await labels.create(params.projectId, body))),
  // update, destroy, … and LabelService, LabelRepository, PgLabelRepository behind them
}));
```

After: the `resource(...)` call above.

## Options

| option | default | |
|---|---|---|
| `scope` | none | `"projects/:projectId"`: URL prefix; each `:param` is a model field used to filter, fill and guard rows |
| `policy` | allow all | a `Policy` instance; each action is authorised (`index(user)`, `show(user, row)`, `store(user, input)`, `update(user, row, input)`, `destroy(user, row)`) → 403 |
| `auth` | off | `true`: every action needs a signed-in user (401); the user reaches the policy |
| `only` / `except` | all five | `only: ["index", "show"]` |
| `filters` | none | fields `index` filters on by equality: `?color=red&archived=false` (values parsed by the field's type) |
| `defaultOrder` | `[primaryKey, "asc"]` | `["createdAt", "desc"]` |
| `pageSize` / `maxPageSize` | 20 / 100 | |
| `name` | from the table | used in "… not found" |

Options must be written inline (an object literal): the builder reads `scope`, `only` and `except` at build time to
register the routes.

## Pagination format

```
GET /projects/p1/labels?page=2&pageSize=10&sort=-createdAt&color=red
```

```json
{
  "data": [ { "id": "…", "name": "bug", "color": "red", "…": "…" } ],
  "meta": { "page": 2, "pageSize": 10, "total": 31, "pages": 4 }
}
```

`sort` is a field name, `-field` for descending. Invalid `page`, `pageSize`, `sort` or filter values are 422 with every
problem listed.

## Custom actions

Add actions next to the generated ones with a third argument; it receives the database and the model's table:

```ts
export const LabelsController = resource(Label, { scope: "projects/:projectId" }, ({ table }) => ({
  archive: post("/:id/archive", {}, ({ id }) => table.update(id, { archived: true })),
}));
```

## Typed client

The client sees exact types for every action:

```ts
const page = await api.labels.index({ params: { projectId }, query: { color: "red", page: 2 } }); // Page<Label>
const label = await api.labels.store({ params: { projectId }, body: { name: "bug" } });          // body: InferCreate<typeof Label>
```

## Notes

- Writes go through `db.table(Model)`, so model events, audit and realtime options apply.
- Scope fields cannot be changed through `update` (they come from the URL); they are ignored in the body.
- Native builds: `resource()` compiles with `--node-islands=off` like hand-written controllers.
