import { action, controller, created, noContent, t } from "@qala/core";
import { CommentService } from "../../application/comment.service";
import { NewComment } from "../../domain/comment";

/** /comments */
export const CommentsController = controller({ comments: CommentService }, ({ comments }) => ({
  store: action({ body: NewComment }, async ({ body }) => created(await comments.add(body))),
  destroy: action({ params: { id: t.uuid() } }, async ({ params }) => {
    await comments.remove(params.id);
    return noContent();
  }),
}));
