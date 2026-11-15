import type { Database } from "@qala/core";
import { Comment, type NewComment } from "../domain/comment";
import { CommentRepository } from "../domain/comment.repository";

/** Comments in PostgreSQL. */
export class PgCommentRepository extends CommentRepository {
  constructor(private readonly db: Database) {
    super();
  }

  private get table() {
    return this.db.table(Comment);
  }

  forTask(taskId: string): Promise<Comment[]> {
    return this.table.all({ where: { taskId }, orderBy: ["createdAt", "asc"] });
  }

  find(id: string): Promise<Comment | null> {
    return this.table.find(id);
  }

  create(input: NewComment): Promise<Comment> {
    return this.table.insert({ taskId: input.taskId, author: input.author, body: input.body });
  }

  delete(id: string): Promise<boolean> {
    return this.table.delete(id);
  }
}
