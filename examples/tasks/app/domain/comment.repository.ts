import type { Comment, NewComment } from "./comment";

/** Storage of comments. */
export abstract class CommentRepository {
  abstract forTask(taskId: string): Promise<Comment[]>;
  abstract find(id: string): Promise<Comment | null>;
  abstract create(input: NewComment): Promise<Comment>;
  abstract delete(id: string): Promise<boolean>;
}
