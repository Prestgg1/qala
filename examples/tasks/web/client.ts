/**
 * What a frontend does: import the backend's types and route manifest (no server code) and call it.
 * Every input and result below is checked by TypeScript against the controllers.
 */
import { ApiError, createClient } from "@qala/client";
import { manifest, type Api } from "../.qala/api";

export function tasksApi(baseUrl: string, token?: string) {
  return createClient<Api>({
    baseUrl,
    manifest,
    headers: (): Record<string, string> => (token === undefined ? {} : { authorization: `Bearer ${token}` }),
  });
}

export async function demo(baseUrl: string, token: string): Promise<void> {
  const api = tasksApi(baseUrl, token);

  const task = await api.tasks.store({ body: { title: "Write the release notes", priority: 1 } });
  //    ^? { id: string; title: string; description: string | null; priority: number; done: boolean; dueAt: string | null; createdAt: string }

  const open = await api.tasks.index({ query: { done: false, limit: 10 } });
  console.log(open.map((t) => `${t.priority} ${t.title}`));

  await api.comments.store({ body: { taskId: task.id, author: "ali", body: "Draft is in the doc" } });
  const thread = await api.tasks.comments({ params: { id: task.id } });
  console.log(thread.length, "comment(s)");

  const done = await api.tasks.complete({ params: { id: task.id } });
  console.log(done.done); // true

  try {
    await api.tasks.complete({ params: { id: task.id } });
  } catch (error) {
    if (error instanceof ApiError) console.log(error.status, error.code); // 422 task_already_completed
  }
}
