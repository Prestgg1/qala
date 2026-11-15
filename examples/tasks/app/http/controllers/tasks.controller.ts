import { action, get, post, t } from "@qala/core";
import { CommentService } from "../../application/comment.service";
import { TaskService } from "../../application/task.service";
import { NewTask, TaskChanges, TaskFilter } from "../../domain/task";

const params = { id: t.uuid() };

/** /tasks — reads are public, writes need a user (`auth: true`, see app/auth.ts). */
export class TasksController {
  constructor(
    private readonly tasks: TaskService,
    private readonly threads: CommentService,
  ) {}

  index = action({ query: TaskFilter }, ({ query }) => this.tasks.list(query));
  show = action({ params }, ({ id }) => this.tasks.get(id));
  store = action({ body: NewTask, auth: true }, ({ body }) => this.tasks.create(body));
  update = action({ params, body: TaskChanges, auth: true }, ({ id, body }) => this.tasks.update(id, body));
  destroy = action({ params, auth: true }, ({ id }) => this.tasks.remove(id));
  complete = post("/:id/complete", { params, auth: true }, ({ id }) => this.tasks.complete(id));
  comments = get("/:id/comments", { params }, ({ id }) => this.threads.forTask(id));
}
