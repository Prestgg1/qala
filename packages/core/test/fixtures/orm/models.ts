import { model, t } from "@qala/core";

export const Project = model("orm_projects", { id: t.uuid(), name: t.string(), archived: t.boolean() });

export const Task = model("orm_tasks", {
  id: t.uuid(),
  projectId: t.uuid(),
  title: t.string(),
  status: t.enum(["todo", "doing", "done"]),
  priority: t.integer(),
  estimate: t.nullable(t.number()),
  dueAt: t.nullable(t.datetime()),
  createdAt: t.datetime(),
});

export const Comment = model("orm_comments", { id: t.uuid(), taskId: t.uuid(), body: t.string(), createdAt: t.datetime() });

export const Reaction = model("orm_reactions", { id: t.uuid(), commentId: t.uuid(), emoji: t.string() });

/** A table whose `status` is a real Postgres enum type (`orm_ticket_status`). */
export const Ticket = model("orm_tickets", { id: t.uuid(), title: t.string(), status: t.enum(["open", "closed"]), tags: t.nullable(t.unknown()) });
