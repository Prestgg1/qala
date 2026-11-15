import { Container, type Provider } from "../container";
import { DomainError, HttpError, NotFoundError, ValidationError } from "../errors";
import { Logger } from "../log";
import type { Issue, SchemaNode } from "../schema";
import type { ActionDef, RuntimeInput } from "./action";
import { Context, RequestData, splitUrl } from "./context";
import type { ControllerDef } from "./controller";
import { compose, type Middleware } from "./middleware";
import { json, Reply } from "./reply";
import { joinPath, Router } from "./router";

/** One controller file, as found by the builder (`.qala/routes.gen.ts`). */
export type ControllerEntry = { name: string; prefix: string; controller: ControllerDef };

/**
 * Turns an error into a response. Return `undefined` to fall back to the default handling
 * (HttpError → its status, DomainError → 422, anything else → 500 and a log line).
 */
export type ErrorHandler = (error: unknown, ctx: Context) => Reply | undefined | Promise<Reply | undefined>;

export type AppOptions = {
  controllers: ControllerEntry[];
  providers?: Provider[];
  /** Global middleware, run for every request (also unmatched ones, so CORS preflight works). */
  middleware?: Middleware[];
  onError?: ErrorHandler;
  logger?: Logger;
  /** Show error messages and stacks of unexpected errors in responses (development only). */
  exposeErrors?: boolean;
};

/** One registered route. */
export class Route {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly controller: string,
    readonly action: string,
    readonly def: ActionDef,
    readonly middleware: Middleware[],
  ) {}
}

/** Conventional resource actions: name → [method, path]. */
const RESOURCE: Record<string, [string, string]> = {
  index: ["GET", ""],
  show: ["GET", "/:id"],
  store: ["POST", ""],
  update: ["PATCH", "/:id"],
  destroy: ["DELETE", "/:id"],
};

export class App {
  readonly container: Container;
  readonly routes: Route[] = [];
  readonly logger: Logger;
  private readonly router = new Router();
  private readonly middleware: Middleware[];
  private readonly onError: ErrorHandler | null;
  private readonly exposeErrors: boolean;

  constructor(options: AppOptions) {
    this.container = new Container(options.providers ?? []);
    this.middleware = options.middleware ?? [];
    this.onError = options.onError ?? null;
    this.logger = options.logger ?? new Logger();
    this.exposeErrors = options.exposeErrors ?? false;
    for (const entry of options.controllers) this.register(entry);
  }

  private register(entry: ControllerEntry): void {
    const actions = entry.controller.actions(this.container);
    for (const name of Object.keys(actions)) {
      const def = actions[name]!;
      let method = def.method;
      let path = def.path;
      if (method === "") {
        const conventional = RESOURCE[name];
        if (conventional === undefined) {
          throw new Error(`${entry.name}.${name}: action() is only for index/show/store/update/destroy; use get()/post()/put()/patch()/del() with a path for other routes`);
        }
        method = conventional[0];
        path = conventional[1];
      }
      const full = joinPath(entry.prefix, path);
      const index = this.routes.length;
      this.routes.push(new Route(method, full, entry.name, name, def, entry.controller.middleware));
      this.router.add(method, full, index);
      if (method === "PATCH" && def.method === "") this.router.add("PUT", full, index);
    }
  }

  /** `{ controller: { action: [method, path] } }`, for the typed client. */
  manifest(): Record<string, Record<string, [string, string]>> {
    const out: Record<string, Record<string, [string, string]>> = {};
    for (const r of this.routes) {
      let c = out[r.controller];
      if (c === undefined) {
        c = {};
        out[r.controller] = c;
      }
      c[r.action] = [r.method, r.path];
    }
    return out;
  }

  /** Handles one request; never throws. */
  async handle(request: RequestData): Promise<Reply> {
    const { path, query } = splitUrl(request.url);
    const ctx = new Context(request, path, this.container);
    ctx.query = query;
    let reply: Reply;
    try {
      reply = await compose(this.middleware, ctx, () => this.dispatch(ctx));
    } catch (error) {
      reply = await this.errorReply(error, ctx);
    }
    const headerNames = Object.keys(ctx.responseHeaders);
    if (headerNames.length === 0) return reply;
    const headers: Record<string, string> = {};
    for (const key of headerNames) headers[key] = ctx.responseHeaders[key]!;
    for (const key of Object.keys(reply.headers)) headers[key] = reply.headers[key]!;
    return new Reply(reply.status, reply.body, headers);
  }

  private async dispatch(ctx: Context): Promise<Reply> {
    const match = this.router.find(ctx.method === "HEAD" ? "GET" : ctx.method, ctx.path);
    if (match === null) {
      const allowed = this.router.methodsFor(ctx.path);
      if (allowed.length > 0) {
        ctx.setHeader("allow", allowed.join(", "));
        throw new HttpError(405, `Method ${ctx.method} not allowed`, "method_not_allowed");
      }
      throw new NotFoundError(`No route for ${ctx.method} ${ctx.path}`);
    }
    const route = this.routes[match.route]!;
    ctx.params = match.params;
    return compose(route.middleware, ctx, () => this.run(route.def, ctx));
  }

  private async run(def: ActionDef, ctx: Context): Promise<Reply> {
    const input: RuntimeInput = { params: ctx.params, query: ctx.query, body: undefined, ctx };
    if (def.params !== null) input.params = check(def.params, ctx.params, true, "route parameters");
    if (def.query !== null) input.query = check(def.query, ctx.query, true, "query");
    if (def.body !== null) input.body = check(def.body, readBody(ctx), false, "body");
    return def.handler(input);
  }

  private async errorReply(error: unknown, ctx: Context): Promise<Reply> {
    if (this.onError !== null) {
      try {
        const custom = await this.onError(error, ctx);
        if (custom !== undefined) return custom;
      } catch (inner) {
        error = inner;
      }
    }
    if (error instanceof HttpError) {
      if (error.status >= 500) this.logger.error(error.message, { method: ctx.method, path: ctx.path });
      return errorBody(error.status, error.code, error.message, error.details);
    }
    if (error instanceof DomainError) return errorBody(422, error.code, error.message, null);
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack ?? "") : "";
    this.logger.error(`Unhandled error: ${message}`, { method: ctx.method, path: ctx.path, stack });
    return errorBody(500, "internal_error", this.exposeErrors ? message : "Internal server error", this.exposeErrors ? stack : null);
  }
}

function errorBody(status: number, code: string, message: string, details: unknown): Reply {
  return json({ error: { status, code, message, details } }, status);
}

function check(schema: SchemaNode, value: unknown, coerce: boolean, where: string): unknown {
  const issues: Issue[] = [];
  const out = schema.check(value, "", issues, coerce);
  if (issues.length > 0) throw new ValidationError(issues, where);
  return out;
}

function readBody(ctx: Context): unknown {
  const raw = ctx.request.body;
  if (raw === "") return undefined;
  const type = ctx.header("content-type") ?? "";
  if (type !== "" && !type.includes("json")) throw new HttpError(415, "Expected a JSON body (content-type: application/json)", "unsupported_media_type");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, "The body is not valid JSON", "invalid_json");
  }
}

export function createApp(options: AppOptions): App {
  return new App(options);
}

export { RequestData };
