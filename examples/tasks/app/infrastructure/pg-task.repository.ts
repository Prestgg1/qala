import type { Database } from "@qala/core";
import { Task, type TaskFilter } from "../domain/task";
import { TaskRepository } from "../domain/task.repository";

/** Tasks in PostgreSQL. */
export class PgTaskRepository extends TaskRepository {
  constructor(private readonly db: Database) {
    super();
  }

  private get table() {
    return this.db.table(Task);
  }

  // Overrides of abstract methods stay non-async (a scriptc rule); async work lives in private helpers.
  list(filter: TaskFilter): Promise<Task[]> {
    const limit = filter.limit ?? 50;
    if (filter.q === undefined) return this.table.all({ where: { done: filter.done }, orderBy: ["createdAt", "desc"], limit });
    return this.search(filter.q, filter.done ?? null, limit);
  }

  /** Text search needs SQL the repository API does not cover: a raw, parameterised query. */
  private async search(q: string, done: boolean | null, limit: number): Promise<Task[]> {
    const rows = await this.db.query(
      "select * from tasks where title ilike $1 and ($2::boolean is null or done = $2) order by created_at desc limit $3",
      [`%${q}%`, done, limit],
    );
    const tasks: Task[] = [];
    for (const row of rows) tasks.push(Task.decode(row) as unknown as Task);
    return tasks;
  }

  find(id: string): Promise<Task | null> {
    return this.table.find(id);
  }

  create(data: Partial<Task>): Promise<Task> {
    return this.table.insert(data);
  }

  update(id: string, data: Partial<Task>): Promise<Task | null> {
    return this.table.update(id, data);
  }

  delete(id: string): Promise<boolean> {
    return this.table.delete(id);
  }
}
