import { DomainError, model, t, type Infer, type InferModel } from "@qala/core";

/** A task as stored in the "tasks" table (camelCase fields ↔ snake_case columns). */
export const Task = model("tasks", {
  id: t.uuid(),
  title: t.string({ min: 1, max: 200 }),
  description: t.nullable(t.string({ max: 5000 })),
  priority: t.integer({ min: 1, max: 4 }),
  done: t.boolean(),
  dueAt: t.nullable(t.datetime()),
  createdAt: t.datetime(),
});
export type Task = InferModel<typeof Task>;

const title = t.string({ min: 1, max: 200 });
const description = t.optional(t.nullable(t.string({ max: 5000 })));
const priority = t.optional(t.integer({ min: 1, max: 4 }));
const dueAt = t.optional(t.nullable(t.datetime()));

/** What a client sends to create a task. */
export const NewTask = t.object({ title, description, priority, dueAt });
export type NewTask = Infer<typeof NewTask>;

/** What a client sends to change a task: every field optional. */
export const TaskChanges = t.object({ title: t.optional(title), description, priority, dueAt });
export type TaskChanges = Infer<typeof TaskChanges>;

/** Filters for listing tasks (query string). */
export const TaskFilter = {
  done: t.optional(t.boolean()),
  q: t.optional(t.string({ min: 1, max: 100 })),
  limit: t.optional(t.integer({ min: 1, max: 100 })),
};
export type TaskFilter = { done?: boolean; q?: string; limit?: number };

export class TaskAlreadyCompleted extends DomainError {
  constructor() {
    super("This task is already completed", "task_already_completed");
  }
}

export class BlankTitle extends DomainError {
  constructor() {
    super("A task title cannot be blank", "task_title_blank");
  }
}

/** Domain rule: titles are trimmed and must keep some text. */
export function cleanTitle(raw: string): string {
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (cleaned === "") throw new BlankTitle();
  return cleaned;
}

/** Domain rule: a task can be completed once. */
export function assertCanComplete(task: Task): void {
  if (task.done) throw new TaskAlreadyCompleted();
}
