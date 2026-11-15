/**
 * Model events: side effects declared once instead of repeated in every service.
 *
 *   // app/events/tasks.ts — imported automatically by the generated entry
 *   on(Task, "created", async (task, ctx) => {
 *     await ctx.service(Notifications).taskCreated(task);
 *   });
 *   on(Task, "updated", (task, before) => { if (task.done && !before.done) … });
 *
 *   // app/domain/task.ts — audit and realtime are model options
 *   export const Task = model("tasks", { … }, { audit: true, realtime: (t) => ({ projectId: t.projectId }) });
 *
 * Events fire for writes through `db.table(Model)` (insert / update / delete), after the change is
 * committed: immediately for single statements, after COMMIT inside `db.transaction(...)` (and never if it
 * rolls back). `audit: true` hands every change to the app's `AuditSink`, `realtime` to its
 * `RealtimeSink` (both resolved from the DI container). Handlers run in registration order; a failing
 * handler is logged and does not undo the write or stop the others.
 */
import type { Container, Token } from "../container";
import type { Model, ModelDef } from "./model";

export type ChangeKind = "created" | "updated" | "deleted";

/** One committed change of a model's row. */
export class ModelChange {
  constructor(
    readonly model: ModelDef,
    readonly kind: ChangeKind,
    /** The row after the change (the deleted row for `deleted`). */
    readonly row: unknown,
    /** The row before an update; null for created/deleted. */
    readonly before: unknown,
  ) {}

  get table(): string {
    return this.model.table;
  }
}

/** Where `audit: true` models send their changes (e.g. an activity_logs insert). Provide one in the app. */
export abstract class AuditSink {
  abstract record(change: ModelChange): Promise<void>;
}

/** Where `realtime` models publish their changes, with the scope the model option returned. Provide one in the app. */
export abstract class RealtimeSink {
  abstract publish(change: ModelChange, scope: unknown): Promise<void>;
}

/** What an event handler gets besides the row: the change and the app's services. */
export class EventContext {
  constructor(
    readonly change: ModelChange,
    private readonly container: Container | null,
  ) {}

  /** A service from the app's DI container. */
  service<T>(token: Token<T>): T {
    if (this.container === null) throw new Error("Model events have no container: the generated entry calls bindEvents(app.container)");
    return this.container.get(token);
  }
}

type RuntimeHandler = (change: ModelChange, ctx: EventContext) => Promise<void>;

/** Handlers by `table:kind`, and the container sinks/services are resolved from. */
class EventRegistry {
  readonly handlers = new Map<string, RuntimeHandler[]>();
  container: Container | null = null;
  private warned = new Set<string>();

  add(model: ModelDef, kind: ChangeKind, handler: RuntimeHandler): void {
    const key = `${model.table}:${kind}`;
    const list = this.handlers.get(key);
    if (list === undefined) this.handlers.set(key, [handler]);
    else list.push(handler);
  }

  has(model: ModelDef, kind: ChangeKind): boolean {
    return this.handlers.has(`${model.table}:${kind}`);
  }

  warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.error(message);
  }
}

const registry = new EventRegistry();

/** Called by the generated entry so handlers and sinks can use the app's services. */
export function bindEvents(container: Container): void {
  registry.container = container;
}

function settle(value: unknown): Promise<void> {
  return Promise.resolve(value).then(() => undefined);
}

/** Runs `handler` after every committed insert of a `Task` row: `on(Task, "created", (task, ctx) => …)`. */
export function on<Row>(model: Model<Row, string>, kind: "created" | "deleted", handler: (row: Row, ctx: EventContext) => unknown): void;
/** Runs `handler` after every committed update, with the row before it: `on(Task, "updated", (task, before, ctx) => …)`. */
export function on<Row>(model: Model<Row, string>, kind: "updated", handler: (row: Row, before: Row, ctx: EventContext) => unknown): void;
export function on<Row>(model: Model<Row, string>, kind: ChangeKind, handler: ((row: Row, ctx: EventContext) => unknown) | ((row: Row, before: Row, ctx: EventContext) => unknown)): void {
  if (kind === "updated") {
    const fn = handler as (row: Row, before: Row, ctx: EventContext) => unknown;
    registry.add(model, kind, (change, ctx) => {
      const row = change.row as Row;
      const before = change.before as Row;
      return settle(fn(row, before, ctx));
    });
    return;
  }
  const fn = handler as (row: Row, ctx: EventContext) => unknown;
  registry.add(model, kind, (change, ctx) => {
    const row = change.row as Row;
    return settle(fn(row, ctx));
  });
}

/** Whether a change of `model` would do anything (so writes skip the extra work otherwise). */
export function hasEffects(model: ModelDef, kind: ChangeKind): boolean {
  return registry.has(model, kind) || model.audit || model.realtime !== null;
}

/** Whether an update needs the row as it was before (an `updated` handler or audit). */
export function needsBefore(model: ModelDef): boolean {
  return registry.has(model, "updated") || model.audit;
}

function fail(what: string, error: unknown): void {
  console.error(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
}

/** Runs everything a committed change triggers: handlers, then audit, then realtime. Never throws. */
export async function dispatch(change: ModelChange): Promise<void> {
  const ctx = new EventContext(change, registry.container);
  const handlers = registry.handlers.get(`${change.model.table}:${change.kind}`);
  if (handlers !== undefined) {
    for (const h of handlers) {
      try {
        await h(change, ctx);
      } catch (error) {
        fail(`${change.model.table} ${change.kind} handler`, error);
      }
    }
  }
  if (change.model.audit) {
    const container = registry.container;
    if (container === null || !container.has(AuditSink)) {
      registry.warnOnce("audit", `${change.model.table} has audit: true but the app provides no AuditSink`);
    } else {
      try {
        await container.get(AuditSink).record(change);
      } catch (error) {
        fail(`${change.model.table} audit`, error);
      }
    }
  }
  const scopeOf = change.model.realtime;
  if (scopeOf !== null) {
    const container = registry.container;
    if (container === null || !container.has(RealtimeSink)) {
      registry.warnOnce("realtime", `${change.model.table} has realtime but the app provides no RealtimeSink`);
    } else {
      try {
        await container.get(RealtimeSink).publish(change, scopeOf(change.row));
      } catch (error) {
        fail(`${change.model.table} realtime`, error);
      }
    }
  }
}

/**
 * Collects the changes of one `Database` (dispatched at once) or one transaction (held until COMMIT,
 * dropped on ROLLBACK).
 */
export class ChangeQueue {
  private pending: ModelChange[] = [];

  constructor(readonly deferred: boolean) {}

  async emit(change: ModelChange): Promise<void> {
    if (this.deferred) this.pending.push(change);
    else await dispatch(change);
  }

  /** After COMMIT: dispatches the held changes in order. */
  async flush(): Promise<void> {
    const changes = this.pending;
    this.pending = [];
    for (const c of changes) await dispatch(c);
  }

  /** After ROLLBACK: the held changes never happened. */
  discard(): void {
    this.pending = [];
  }
}

/** Test helper: removes every registered handler and the bound container. */
export function resetEvents(): void {
  registry.handlers.clear();
  registry.container = null;
}
