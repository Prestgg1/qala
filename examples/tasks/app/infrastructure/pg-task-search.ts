import { run, type Database } from "@qala/core";
import { Queries } from "../../.qala/queries.gen";
import { TaskSearch, type Task, type TaskFilter } from "../domain/task";

export class PgTaskSearch extends TaskSearch {
  constructor(private readonly db: Database) {
    super();
  }

  find(filter: TaskFilter): Promise<Task[]> {
    return run(this.db, Queries.listTasks, { done: filter.done, q: filter.q === undefined ? undefined : `%${filter.q}%`, limit: filter.limit ?? 50 });
  }
}
