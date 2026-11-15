import { model, t, type Infer, type InferModel } from "@qala/core";
import { Task } from "./task";

/** A comment on a task ("comments" table). */
export const Comment = model("comments", {
  id: t.uuid().primary(),
  taskId: t.uuid().references(Task, { onDelete: "cascade" }),
  author: t.string({ min: 1, max: 100 }),
  body: t.string({ min: 1, max: 2000 }),
  createdAt: t.datetime().now(),
});
export type Comment = InferModel<typeof Comment>;

/** What a client sends to comment on a task. */
export const NewComment = t.object({ taskId: t.uuid(), author: t.string({ min: 1, max: 100 }), body: t.string({ min: 1, max: 2000 }) });
export type NewComment = Infer<typeof NewComment>;
