import { model, t, type Infer, type InferModel } from "@qala/core";

/** A comment on a task ("comments" table; task_id references tasks). */
export const Comment = model("comments", {
  id: t.uuid(),
  taskId: t.uuid(),
  author: t.string({ min: 1, max: 100 }),
  body: t.string({ min: 1, max: 2000 }),
  createdAt: t.datetime(),
});
export type Comment = InferModel<typeof Comment>;

/** What a client sends to comment on a task. */
export const NewComment = t.object({
  taskId: t.uuid(),
  author: t.string({ min: 1, max: 100 }),
  body: t.string({ min: 1, max: 2000 }),
});
export type NewComment = Infer<typeof NewComment>;
