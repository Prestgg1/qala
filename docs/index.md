---
layout: home
title: Qala
hero:
  name: Qala
  text: Short, structured, native TypeScript backends
  tagline: Controllers, DI, models and migrations in a few lines, compiled to a ~3 MB binary that runs without Node.js or Bun.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/Prestgg1/qala
features:
  - title: Short code by convention
    details: A route is one line. Validation, status codes, error responses and wiring are conventions, not boilerplate.
  - title: Native binary
    details: Your app compiles with scriptc to one ~3 MB executable. About 5 MB idle memory and a 7 ms startup.
  - title: End-to-end types
    details: Request schemas and handler return types flow to the frontend client. Rename a field and the frontend fails to compile.
  - title: ORM compiler
    details: Queries written in TypeScript are compiled into SQL, prepared statements and typed decoders, with no N+1 loads.
  - title: Clean Architecture enforced
    details: Folders are layers and qala check fails the build when HTTP reaches into infrastructure.
  - title: Batteries included
    details: Own PostgreSQL client, migrations, middleware, config, WebSockets, SSE, multi-core serving and a code-generating CLI.
---

## A resource controller

```ts
// app/http/controllers/tasks.controller.ts → routes are registered from the file name
export const TasksController = controller({ tasks: TaskService }, ({ tasks }) => ({
  index:   action({ query: { done: t.optional(t.boolean()) } }, ({ query }) => tasks.list(query)),
  show:    action({ params: { id: t.uuid() } }, ({ params }) => tasks.get(params.id)),
  store:   action({ body: CreateTask }, async ({ body }) => created(await tasks.create(body))),
  destroy: action({ params: { id: t.uuid() } }, async ({ params }) => { await tasks.remove(params.id); return noContent(); }),
}));
```

## The typed client

```ts
const api = createClient<Api>({ baseUrl: "/api", manifest });
const task = await api.tasks.show({ params: { id } });   // task: { id: string; title: string; done: boolean; ... }
await api.tasks.store({ body: { title: 1 } });            // type error: title must be a string
```
