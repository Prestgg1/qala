import { Database, singleton, type Provider } from "@qala/core";
import { config } from "../config/app";
import { CommentService } from "./application/comment.service";
import { TaskService } from "./application/task.service";
import { CommentRepository } from "./domain/comment.repository";
import { TaskRepository } from "./domain/task.repository";
import { PgCommentRepository } from "./infrastructure/pg-comment.repository";
import { PgTaskRepository } from "./infrastructure/pg-task.repository";

/** The composition root: which implementation serves each dependency. */
export const providers: Provider[] = [
  singleton(Database, () => new Database(config.databaseUrl, { max: 10 })),
  singleton(TaskRepository, (c) => new PgTaskRepository(c.get(Database))),
  singleton(CommentRepository, (c) => new PgCommentRepository(c.get(Database))),
  singleton(TaskService, (c) => new TaskService(c.get(TaskRepository))),
  singleton(CommentService, (c) => new CommentService(c.get(CommentRepository), c.get(TaskService))),
];
