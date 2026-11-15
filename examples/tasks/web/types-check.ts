/**
 * Compile-time proof of end-to-end type safety: each `@ts-expect-error` line must be an error,
 * and `tsc` fails if one of them stops being one. Nothing here runs.
 */
import { createClient } from "@qala/client";
import { manifest, type Api } from "../.qala/api";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

const api = createClient<Api>({ baseUrl: "http://localhost:3000", manifest });

export async function checks(id: string): Promise<void> {
  // Results carry the model's types.
  const task = await api.tasks.show({ params: { id } });
  type _show = Expect<Equal<typeof task.dueAt, string | null>>;
  const list = await api.tasks.index();
  type _list = Expect<Equal<(typeof list)[number]["priority"], number>>;

  // @ts-expect-error: body field with the wrong type (priority is a number)
  await api.tasks.store({ body: { title: "x", priority: "high" } });
  // @ts-expect-error: required body field missing
  await api.tasks.store({ body: { priority: 1 } });
  // @ts-expect-error: unknown body field
  await api.comments.store({ body: { taskId: id, author: "a", body: "b", likes: 3 } });
  // @ts-expect-error: show needs params.id
  await api.tasks.show();
  // @ts-expect-error: wrong param name
  await api.tasks.complete({ params: { taskId: id } });
  // @ts-expect-error: query value of the wrong type
  await api.tasks.index({ query: { done: "yes" } });
  // @ts-expect-error: no such action
  await api.tasks.archive({ params: { id } });
  // @ts-expect-error: no such controller
  await api.projects.index();
  // @ts-expect-error: results are typed too (title is a string)
  const n: number = task.title;
  void n;
}
