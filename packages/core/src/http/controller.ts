import type { Container, Token } from "../container";
import type { ActionDef } from "./action";
import type { Middleware } from "./middleware";

type Deps = Record<string, Token<unknown>>;
type Resolved<D extends Deps> = { [K in keyof D]: D[K] extends Token<infer T> ? T : never };

/** A controller at run time: its dependencies, middleware and a factory for its actions. */
export class ControllerDef {
  constructor(
    readonly depNames: string[],
    readonly depTokens: unknown[],
    readonly build: (deps: Record<string, unknown>) => Record<string, ActionDef>,
    readonly middleware: Middleware[],
  ) {}

  /** The actions with dependencies resolved from `container`. */
  actions(container: Container): Record<string, ActionDef> {
    const deps: Record<string, unknown> = {};
    for (let i = 0; i < this.depNames.length; i++) deps[this.depNames[i]!] = container.resolve(this.depTokens[i]);
    return this.build(deps);
  }
}

/** The typed view of a controller: `A` maps action names to `Action` types (read by the client). */
export type Controller<A> = ControllerDef & { readonly __actions?: () => A };

export type ControllerOptions = { middleware?: Middleware[] };

/**
 * Declares a controller. Its routes are registered automatically from the file name:
 * `app/http/controllers/tasks.controller.ts` serves `/tasks`, and the actions named
 * index/show/store/update/destroy become `GET /tasks`, `GET /tasks/:id`, `POST /tasks`,
 * `PATCH /tasks/:id`, `DELETE /tasks/:id`.
 *
 *   export const TasksController = controller({ tasks: TaskService }, ({ tasks }) => ({
 *     index: action({}, () => tasks.list()),
 *     show: action({}, ({ params }) => tasks.get(params.id)),
 *   }));
 */
export function controller<const D extends Deps, A extends Record<string, ActionDef>>(deps: D, build: (deps: Resolved<D>) => A, options: ControllerOptions = {}): Controller<A> {
  const names = Object.keys(deps);
  const tokens: unknown[] = [];
  for (const name of names) tokens.push(deps[name]);
  return new ControllerDef(names, tokens, build as unknown as (deps: Record<string, unknown>) => Record<string, ActionDef>, options.middleware ?? []);
}
