// Type-level tests: checked by `tsc -p tsconfig.json` (not run).
import { createClient, type Client } from "@qala/client";
import { type Api, manifest } from "./fixture";

type Equal<X, Y> = (<G>() => G extends X ? 1 : 2) extends <G>() => G extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

declare const api: Client<Api>;
type R<F> = F extends (...args: never[]) => Promise<infer O> ? O : never;
type P<F> = F extends (input: infer I, ...rest: never[]) => unknown ? I : never;

type TaskJson = { id: string; title: string; done: boolean; createdAt: string; note?: string };

export type Cases = [
  Expect<Equal<R<typeof api.tasks.show>, TaskJson>>,
  Expect<Equal<R<typeof api.tasks.index>, TaskJson[]>>,
  Expect<Equal<R<typeof api.tasks.store>, TaskJson>>,
  Expect<Equal<R<typeof api.tasks.destroy>, null>>,
  Expect<Equal<R<typeof api.tasks.silent>, null>>,
  Expect<Equal<R<typeof api.tasks.echo>, { name: string; tags: string }>>,
  Expect<Equal<P<typeof api.tasks.show>, { params: { id: string } }>>,
  Expect<Equal<P<typeof api.tasks.store>, { body: { title: string; note?: string | undefined } }>>,
  Expect<Equal<P<typeof api.tasks.complete>, { params: { id: string } }>>,
];

export async function misuse(): Promise<void> {
  const typed = createClient<Api>({ baseUrl: "", manifest });
  await typed.tasks.index();
  await typed.tasks.index({ query: { done: true } });
  // @ts-expect-error body is required
  await typed.tasks.store({});
  // @ts-expect-error no argument at all: body is required
  await typed.tasks.store();
  // @ts-expect-error title must be a string
  await typed.tasks.store({ body: { title: 1 } });
  // @ts-expect-error unknown action
  await typed.tasks.archive();
  // @ts-expect-error unknown controller
  await typed.users.index();
  // @ts-expect-error wrong param name
  await typed.tasks.show({ params: { taskId: "1" } });
  // @ts-expect-error query value has the wrong type
  await typed.tasks.index({ query: { done: "yes" } });
  // @ts-expect-error echo requires its query
  await typed.tasks.echo({ params: { name: "x" } });
}
