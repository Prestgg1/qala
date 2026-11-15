import { errors, model, t, type Infer, type InferModel } from "@qala/core";

/** The "tasks" table: the single source of the row type, decoders and migrations. */
export const Task = model("tasks", {
  id: t.uuid().primary(),
  title: t.string({ min: 1, max: 200 }).unique(),
  description: t.string({ max: 5000 }).nullable(),
  priority: t.integer({ min: 1, max: 4 }).default(2),
  done: t.boolean().default(false),
  dueAt: t.datetime().nullable(),
  createdAt: t.datetime().now().index(),
});
export type Task = InferModel<typeof Task>;

const title = t.string({ min: 1, max: 200 });
const details = {
  description: t.optional(t.nullable(t.string({ max: 5000 }))),
  priority: t.optional(t.integer({ min: 1, max: 4 })),
  dueAt: t.optional(t.nullable(t.datetime())),
};

/** What a client sends to create a task, and to change one (every field optional). */
export const NewTask = t.object({ title, ...details });
export const TaskChanges = t.object({ title: t.optional(title), ...details });
export type NewTask = Infer<typeof NewTask>;
export type TaskChanges = Infer<typeof TaskChanges>;

/** Filters for listing tasks (query string). */
export const TaskFilter = {
  done: t.optional(t.boolean()),
  q: t.optional(t.string({ min: 1, max: 100 })),
  limit: t.optional(t.integer({ min: 1, max: 100 })),
};
export type TaskFilter = { done?: boolean; q?: string; limit?: number };

export const TaskErrors = errors({
  TaskTitleBlank: [422, "A task title cannot be blank"],
  TaskAlreadyCompleted: [422, "This task is already completed"],
});

/** Domain rule: titles are trimmed and must keep some text. */
export function cleanTitle(raw: string): string {
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (cleaned === "") throw TaskErrors.TaskTitleBlank();
  return cleaned;
}

/** Text search over tasks: the one query the table API does not cover (implemented in infrastructure). */
export abstract class TaskSearch {
  abstract find(filter: TaskFilter): Promise<Task[]>;
}
