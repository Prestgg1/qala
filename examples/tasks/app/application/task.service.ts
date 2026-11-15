import type { Database } from "@qala/core";
import { cleanTitle, Task, TaskErrors, TaskSearch, type NewTask, type TaskChanges, type TaskFilter } from "../domain/task";

/** Task use cases. `null` means "no such task" (the HTTP layer answers 404), `undefined` "done, nothing to send" (204). */
export class TaskService {
  constructor(
    private readonly db: Database,
    private readonly search: TaskSearch,
  ) {}

  private get tasks() {
    return this.db.table(Task);
  }

  list(filter: TaskFilter): Promise<Task[]> {
    return this.search.find(filter);
  }

  get(id: string): Promise<Task | null> {
    return this.tasks.find(id);
  }

  create(input: NewTask): Promise<Task> {
    return this.tasks.insert({ ...input, title: cleanTitle(input.title) });
  }

  update(id: string, changes: TaskChanges): Promise<Task | null> {
    return this.tasks.update(id, { ...changes, title: changes.title === undefined ? undefined : cleanTitle(changes.title) });
  }

  async complete(id: string): Promise<Task | null> {
    const task = await this.get(id);
    if (task?.done === true) throw TaskErrors.TaskAlreadyCompleted();
    return task === null ? null : this.tasks.update(id, { done: true });
  }

  async remove(id: string): Promise<null | undefined> {
    return (await this.tasks.delete(id)) ? undefined : null;
  }
}
