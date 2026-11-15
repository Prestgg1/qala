import type { Task, TaskFilter } from "./task";

/** Storage of tasks. The application layer depends on this contract; infrastructure implements it. */
export abstract class TaskRepository {
  abstract list(filter: TaskFilter): Promise<Task[]>;
  abstract find(id: string): Promise<Task | null>;
  abstract create(data: Partial<Task>): Promise<Task>;
  abstract update(id: string, data: Partial<Task>): Promise<Task | null>;
  abstract delete(id: string): Promise<boolean>;
}
