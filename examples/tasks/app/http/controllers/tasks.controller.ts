import { action, controller, created, get, noContent, post, t } from "@qala/core";
import { CommentService } from "../../application/comment.service";
import { TaskService } from "../../application/task.service";
import { NewTask, TaskChanges, TaskFilter } from "../../domain/task";

const id = { id: t.uuid() };

/** /tasks — routes come from the file name and the action names. */
export const TasksController = controller({ tasks: TaskService, comments: CommentService }, ({ tasks, comments }) => ({
  index: action({ query: TaskFilter }, ({ query }) => tasks.list(query)),
  show: action({ params: id }, ({ params }) => tasks.get(params.id)),
  store: action({ body: NewTask }, async ({ body }) => created(await tasks.create(body))),
  update: action({ params: id, body: TaskChanges }, ({ params, body }) => tasks.update(params.id, body)),
  destroy: action({ params: id }, async ({ params }) => {
    await tasks.remove(params.id);
    return noContent();
  }),
  complete: post("/:id/complete", { params: id }, ({ params }) => tasks.complete(params.id)),
  comments: get("/:id/comments", { params: id }, ({ params }) => comments.forTask(params.id)),
}));
