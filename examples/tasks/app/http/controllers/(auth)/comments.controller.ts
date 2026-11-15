import { action, t } from "@qala/core";
import { CommentService } from "../../../application/comment.service";
import { NewComment } from "../../../domain/comment";

/** /comments — the (auth) folder makes every action require a user. */
export class CommentsController {
  constructor(private readonly comments: CommentService) {}

  store = action({ body: NewComment }, ({ body }) => this.comments.add(body));
  destroy = action({ params: { id: t.uuid() } }, ({ id }) => this.comments.remove(id));
}
