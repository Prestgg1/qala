import { action, controller, createApp, created, get, noContent, NotFoundError, post, RequestData, singleton, t } from "@qala/core";
import type { Transport } from "@qala/client";

export type Task = { id: string; title: string; done: boolean; createdAt: Date; note?: string; secret?: undefined };

export class Tasks {
  private items = new Map<string, Task>();
  private seq = 0;
  list(done?: boolean): Task[] {
    return [...this.items.values()].filter((x) => done === undefined || x.done === done);
  }
  find(id: string): Task {
    const x = this.items.get(id);
    if (x === undefined) throw new NotFoundError("Task not found");
    return x;
  }
  add(title: string, note?: string): Task {
    const x: Task = { id: String(++this.seq), title, done: false, createdAt: new Date("2026-01-02T03:04:05.000Z"), ...(note === undefined ? {} : { note }) };
    this.items.set(x.id, x);
    return x;
  }
  remove(id: string): void {
    this.find(id);
    this.items.delete(id);
  }
}

export const TasksController = controller({ tasks: Tasks }, ({ tasks }) => ({
  index: action({ query: { done: t.optional(t.boolean()), q: t.optional(t.string()) } }, ({ query }) => tasks.list(query.done)),
  show: action({ params: { id: t.string() } }, ({ params }) => tasks.find(params.id)),
  store: action({ body: t.object({ title: t.string({ min: 1 }), note: t.optional(t.string()) }) }, ({ body }) => created(tasks.add(body.title, body.note))),
  destroy: action({ params: { id: t.string() } }, ({ params }) => {
    tasks.remove(params.id);
    return noContent();
  }),
  complete: post("/:id/complete", {}, ({ params }) => {
    const x = tasks.find(params.id);
    x.done = true;
    return x;
  }),
  echo: get("/echo/:name", { query: { tags: t.string() } }, ({ params, query }) => ({ name: params.name, tags: query.tags, fn: () => 1 })),
  silent: post("/silent", {}, () => undefined),
}));

export type Api = { tasks: typeof TasksController };

export const manifest = {
  tasks: {
    index: ["GET", "/tasks"],
    show: ["GET", "/tasks/:id"],
    store: ["POST", "/tasks"],
    destroy: ["DELETE", "/tasks/:id"],
    complete: ["POST", "/tasks/:id/complete"],
    echo: ["GET", "/tasks/echo/:name"],
    silent: ["POST", "/tasks/silent"],
  },
} as const;

export function inProcess(): { transport: Transport; seen: string[] } {
  const app = createApp({ controllers: [{ name: "tasks", prefix: "/tasks", controller: TasksController }], providers: [singleton(Tasks, () => new Tasks())] });
  const seen: string[] = [];
  const transport: Transport = async (req) => {
    const u = new URL(req.url);
    seen.push(`${req.method} ${u.pathname}${u.search}`);
    const reply = await app.handle(new RequestData(req.method, u.pathname + u.search, req.headers, req.body, "test"));
    return { status: reply.status, body: reply.body };
  };
  return { transport, seen };
}
