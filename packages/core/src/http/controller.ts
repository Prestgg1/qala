import type { Container, Token } from "../container";
import type { ModelDef } from "../db/model";
import type { ActionDef } from "./action";
import type { Middleware } from "./middleware";

type Deps = Record<string, Token<unknown>>;
type Resolved<D extends Deps> = { [K in keyof D]: D[K] extends Token<infer T> ? T : never };

/** A controller at run time: its dependencies, middleware and a factory for its actions. */
export class ControllerDef {
  /** The resource a returned `null` names in its 404, e.g. "Task" (set by `resource()`; "" → "Not found"). */
  resourceName = "";
  /** What `resource()` serves, for documentation (`@qala/openapi`); null for other controllers. */
  resource: ResourceMeta | null = null;

  constructor(
    readonly depNames: string[],
    readonly depTokens: unknown[],
    readonly build: (deps: Record<string, unknown>) => Record<string, ActionDef>,
    readonly middleware: Middleware[],
    /** Runs the app's `authenticate` before every action (the `auth: true` option or a `controllers/(auth)/` file). */
    readonly auth: boolean = false,
  ) {}

  /** The same controller with authentication required (used by the generated routes for `(auth)` folders). */
  withAuth(): ControllerDef {
    const out = new ControllerDef(this.depNames, this.depTokens, this.build, this.middleware, true);
    out.resourceName = this.resourceName;
    out.resource = this.resource;
    return out;
  }

  /** The actions with dependencies resolved from `container`. */
  actions(container: Container): Record<string, ActionDef> {
    const deps: Record<string, unknown> = {};
    for (let i = 0; i < this.depNames.length; i++) deps[this.depNames[i]!] = container.resolve(this.depTokens[i]);
    return this.build(deps);
  }
}

/** The model, `index` filters and policy of a `resource()` controller. */
export class ResourceMeta {
  constructor(
    readonly model: ModelDef,
    readonly filters: string[],
    readonly hasPolicy: boolean,
    readonly pageSize: number,
    readonly maxPageSize: number,
  ) {}
}

/** The typed view of a controller: `A` maps action names to `Action` types (read by the client). */
export type Controller<A> = ControllerDef & { readonly __actions?: () => A };

export type ControllerOptions = { middleware?: Middleware[]; auth?: boolean };

/**
 * Declares a controller (or write a class, see `classController`). Its routes are registered automatically from the file name:
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
  return new ControllerDef(names, tokens, build as unknown as (deps: Record<string, unknown>) => Record<string, ActionDef>, options.middleware ?? [], options.auth ?? false);
}

/** The actions of a class controller: its public fields holding actions (constructor dependencies are private). */
export type ClassActions<T> = { [K in keyof T as T[K] extends ActionDef ? K : never]: T[K] };
/** The typed view of a class controller, for the client (`.qala/api.ts`). */
export type ClassController<T> = Controller<ClassActions<T>>;

/**
 * A class controller as the generated routes register it. The class is resolved from the container
 * (its constructor dependencies are injected by the generated providers) and `pick` — generated from the
 * class's action fields — lists its actions statically:
 *
 *   export class TasksController {
 *     constructor(private tasks: TaskService) {}
 *     index = action({}, () => this.tasks.list());
 *   }
 */
export function classController<T>(cls: Token<T>, pick: (instance: T) => Record<string, ActionDef>, options: ControllerOptions = {}): ControllerDef {
  const build = (deps: Record<string, unknown>): Record<string, ActionDef> => pick(deps["self"] as T);
  return new ControllerDef(["self"], [cls], build, options.middleware ?? [], options.auth ?? false);
}
