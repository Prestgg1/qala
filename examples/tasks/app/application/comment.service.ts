import { NotFoundError } from "@qala/core";
import type { Comment, NewComment } from "../domain/comment";
import { CommentRepository } from "../domain/comment.repository";
import { TaskService } from "./task.service";

/** Comment use cases: a comment always belongs to an existing task. */
export class CommentService {
  constructor(
    private readonly comments: CommentRepository,
    private readonly tasks: TaskService,
  ) {}

  async forTask(taskId: string): Promise<Comment[]> {
    await this.tasks.get(taskId);
    return this.comments.forTask(taskId);
  }

  async add(input: NewComment): Promise<Comment> {
    await this.tasks.get(input.taskId);
    return this.comments.create(input);
  }

  async remove(id: string): Promise<void> {
    if (!(await this.comments.delete(id))) throw new NotFoundError(`Comment ${id} not found`);
  }
}
