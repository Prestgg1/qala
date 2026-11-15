import { NotFoundError } from "@qala/core";
import { assertCanComplete, cleanTitle, type NewTask, type Task, type TaskChanges, type TaskFilter } from "../domain/task";
import { TaskRepository } from "../domain/task.repository";

/** Task use cases. Knows the domain rules and the repository contract, nothing about HTTP or SQL. */
export class TaskService {
  constructor(private readonly tasks: TaskRepository) {}

  list(filter: TaskFilter): Promise<Task[]> {
    return this.tasks.list(filter);
  }

  async get(id: string): Promise<Task> {
    const task = await this.tasks.find(id);
    if (task === null) throw new NotFoundError(`Task ${id} not found`);
    return task;
  }

  create(input: NewTask): Promise<Task> {
    return this.tasks.create({ title: cleanTitle(input.title), description: input.description, priority: input.priority, dueAt: input.dueAt });
  }

  async update(id: string, changes: TaskChanges): Promise<Task> {
    const title = changes.title === undefined ? undefined : cleanTitle(changes.title);
    const data: Partial<Task> = { title, description: changes.description, priority: changes.priority, dueAt: changes.dueAt };
    const task = await this.tasks.update(id, data);
    if (task === null) throw new NotFoundError(`Task ${id} not found`);
    return task;
  }

  async complete(id: string): Promise<Task> {
    assertCanComplete(await this.get(id));
    const task = await this.tasks.update(id, { done: true });
    if (task === null) throw new NotFoundError(`Task ${id} not found`);
    return task;
  }

  async remove(id: string): Promise<void> {
    if (!(await this.tasks.delete(id))) throw new NotFoundError(`Task ${id} not found`);
  }
}
