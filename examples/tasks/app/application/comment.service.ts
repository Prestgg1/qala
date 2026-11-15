import type { Database } from "@qala/core";
import { Comment, type NewComment } from "../domain/comment";
import { TaskService } from "./task.service";

/** Comment use cases: a comment always belongs to an existing task (`null` → 404). */
export class CommentService {
  constructor(
    private readonly db: Database,
    private readonly tasks: TaskService,
  ) {}

  private get comments() {
    return this.db.table(Comment);
  }

  async forTask(taskId: string): Promise<Comment[] | null> {
    if ((await this.tasks.get(taskId)) === null) return null;
    return this.comments.all({ where: { taskId }, orderBy: ["createdAt", "asc"] });
  }

  async add(input: NewComment): Promise<Comment | null> {
    if ((await this.tasks.get(input.taskId)) === null) return null;
    return this.comments.insert(input);
  }

  async remove(id: string): Promise<null | undefined> {
    return (await this.comments.delete(id)) ? undefined : null;
  }
}
