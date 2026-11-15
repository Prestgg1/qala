import { and, asc, coalesce, count, deleteFrom, defineQuery, desc, eq, exists, from, gte, ilike, inList, insertInto, isNotNull, many, max, not, notExists, one, or, param, query, sum, update } from "@qala/core/query";
import { Comment, Project, Reaction, Task, Ticket } from "./models";

/** A project's tasks with optional filters, their project, comments and the comments' reactions. */
export const projectTasks = defineQuery({
  params: { projectId: param.uuid(), status: param.optional(param.enum(["todo", "doing", "done"])), q: param.optional(param.text()), limit: param.optional(param.int()) },
  query: (p) =>
    from({ t: Task })
      .where((r) => and(eq(r.t.projectId, p.projectId), eq(r.t.status, p.status), ilike(r.t.title, p.q)))
      .orderBy((r) => [desc(r.t.priority), asc(r.t.title)])
      .limit(p.limit)
      .select((r) => ({
        id: r.t.id,
        title: r.t.title,
        status: r.t.status,
        estimate: r.t.estimate,
        dueAt: r.t.dueAt,
        project: one({ pr: Project }, { key: (c) => c.pr.id, parent: r.t.projectId, query: (q) => q.select((c) => ({ id: c.pr.id, name: c.pr.name })) }),
        comments: many({ c: Comment }, {
          key: (c) => c.c.taskId,
          parent: r.t.id,
          query: (q) =>
            q.orderBy((c) => [asc(c.c.createdAt)]).select((c) => ({
              id: c.c.id,
              body: c.c.body,
              reactions: many({ re: Reaction }, { key: (x) => x.re.commentId, parent: c.c.id, query: (rq) => rq.orderBy((x) => [x.re.emoji]).select((x) => ({ emoji: x.re.emoji })) }),
            })),
        }),
      })),
});

/** Every task (whole rows) of some ids. */
export const tasksByIds = defineQuery({
  params: { ids: param.array(param.uuid()) },
  query: (p) => from({ t: Task }).where((r) => inList(r.t.id, p.ids)).orderBy((r) => [r.t.title]).select((r) => r.t),
});

/** Status counts and priority sums per project. */
export const statusSummary = defineQuery({
  params: { projectId: param.uuid() },
  query: (p) =>
    from({ t: Task })
      .where((r) => eq(r.t.projectId, p.projectId))
      .groupBy((r) => [r.t.status])
      .orderBy((r) => [r.t.status])
      .select((r) => ({ status: r.t.status, tasks: count(), priority: sum(r.t.priority), latest: max(r.t.createdAt) })),
});

/** Projects with their tasks' titles (LEFT JOIN: a project without tasks has a null title). */
export const projectTaskTitles = defineQuery({
  query: () =>
    from({ pr: Project })
      .leftJoin({ t: Task }, (r) => eq(r.t.projectId, r.pr.id))
      .where((r) => not(r.pr.archived))
      .orderBy((r) => [r.pr.name, r.t.title])
      .select((r) => ({ project: r.pr.name, title: r.t.title, priority: r.t.priority })),
});

/** Tasks nobody commented on, and urgent ones with comments. */
export const quietTasks = defineQuery({
  params: { minPriority: param.int() },
  query: (p) =>
    from({ t: Task })
      .where((r) => or(notExists(from({ c: Comment }).where((x) => eq(x.c.taskId, r.t.id))), and(gte(r.t.priority, p.minPriority), exists(from({ c: Comment }).where((x) => eq(x.c.taskId, r.t.id))), isNotNull(r.t.dueAt))))
      .orderBy((r) => [r.t.title])
      .select((r) => ({ title: r.t.title })),
});

/** The most urgent task of a project, or null. */
export const topTask = defineQuery({
  params: { projectId: param.uuid() },
  query: (p) => from({ t: Task }).where((r) => eq(r.t.projectId, p.projectId)).orderBy((r) => [desc(r.t.priority), r.t.title]).select((r) => ({ id: r.t.id, title: r.t.title })).first(),
});

export const createTask = defineQuery({
  params: { projectId: param.uuid(), title: param.text(), priority: param.int() },
  query: (p) => insertInto(Task, { projectId: p.projectId, title: p.title, priority: p.priority, status: "todo" }).returning((r) => ({ id: r.id, title: r.title, status: r.status, createdAt: r.createdAt })),
});

export const setStatus = defineQuery({
  params: { id: param.uuid(), status: param.enum(["todo", "doing", "done"]) },
  query: (p) => update({ t: Task }, { status: p.status }).where((r) => eq(r.t.id, p.id)).returning((r) => ({ id: r.t.id, status: r.t.status })),
});

export const deleteTask = defineQuery({
  params: { id: param.uuid() },
  query: (p) => deleteFrom({ t: Task }).where((r) => eq(r.t.id, p.id)),
});

// ---------------------------------------------------------------- query(($) => …): parameters typed by use

/** Same filters as projectTasks, with inferred parameters and single-model sources. */
export const boardTasks = query(($) =>
  from(Task)
    .where((t) => and(t.projectId.eq($.projectId), t.status.eq($.status.optional()), t.title.ilike($.q.optional())))
    .orderBy((t) => [t.priority.desc(), t.title])
    .limit($.limit.optional())
    .select((t) => ({
      id: t.id,
      title: t.title,
      comments: many(Comment, { key: (c) => c.taskId, parent: t.id, query: (q) => q.orderBy((c) => [c.createdAt]).select((c) => ({ body: c.body })) }),
    })),
);

/** Whole rows, no selection written. */
export const tasksIn = query(($) => from(Task).where((t) => t.id.in($.ids)).orderBy((t) => [t.title]));

/** One whole row or null. */
export const findTask = query(($) => from(Task).where((t) => t.id.eq($.id)).first());

export const renameTask = query(($) => update(Task, { title: $.title }).where((t) => t.id.eq($.id)).returning((t) => ({ id: t.id, title: t.title })));

/** Enum column: no casts written; Postgres types the parameter from the column. */
export const ticketsByStatus = query(($) => from(Ticket).where((t) => t.status.eq($.status.optional())).orderBy((t) => [t.title]).select((t) => ({ title: t.title, status: t.status })));

export const openTicket = query(($) => insertInto(Ticket, { title: $.title, status: $.status }).returning((t) => ({ title: t.title, status: t.status })));

export const closeTickets = query(($) => update(Ticket, { status: "closed" }).where((t) => t.title.in($.titles)));

/** coalesce(...) is never null: no notNull(...) needed. */
export const priorityTotal = query(($) => from(Task).where((t) => t.projectId.eq($.projectId)).select((t) => ({ total: coalesce(sum(t.priority), 0) })).first());
