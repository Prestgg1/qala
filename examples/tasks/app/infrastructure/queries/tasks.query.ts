import { and, from, query } from "@qala/core/query";
import { Task } from "../../domain/task";

/** Newest first; every filter is optional. Parameter types come from the columns they are compared with. */
export const listTasks = query(($) =>
  from(Task)
    .where((t) => and(t.done.eq($.done.optional()), t.title.ilike($.q.optional())))
    .orderBy((t) => [t.createdAt.desc()])
    .limit($.limit),
);
