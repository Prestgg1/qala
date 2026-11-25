import { Container, type Provider } from "../container";
import { Database } from "../db/database";
import { DatabaseError } from "../db/pg";
import { DomainError, HttpError, NotFoundError, UnauthorizedError, ValidationError } from "../errors";
import { pickLocale, translate } from "../i18n/messages";
import { Logger } from "../log";
import type { Issue, SchemaNode } from "../schema";
import type { ActionDef, RuntimeInput } from "./action";
import { type Authenticate, USER_KEY } from "./auth";
import { randomBytes } from "node:crypto";
import { readBody } from "./body";
import { Context, RequestData, splitUrl, validRequestId } from "./context";
import type { ControllerDef } from "./controller";
import { Lifecycle, type ShutdownHook } from "./lifecycle";
import { compose, type Middleware } from "./middleware";
import { json, Reply } from "./reply";
import { joinPath, Router } from "./router";
import { StreamReply } from "./stream";
import type { WsHandlers } from "./websocket";

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
  /** Resolves the signed-in user for actions/controllers with `auth` (generated from `app/auth.ts`). */
  authenticate?: Authenticate;
  /** Default locale of framework messages ("en"); a supported `Accept-Language` overrides it per request. */
  locale?: string;
  /**
   * Built-in `GET /health` (liveness: 200 while the process runs) and `GET /ready` (readiness: 503 once shutdown
   * started or when the database does not answer `select 1` in time). On by default; a route of your own on
   * either path wins. `false` turns both off.
   */
  health?: boolean;
  /** How long `/ready` waits for the database, in ms (default 1000). */
  readyTimeout?: number;
  /**
   * Request ids (default true): a valid incoming `x-request-id` is reused, otherwise one is generated; it is on
   * `ctx.requestId`, in every `ctx.log` line and echoed as the `x-request-id` response header.
   */
  requestId?: boolean;
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
    /** "required" / "optional" / "": whether the app authenticates before the handler. */
    readonly auth: string = "",
    /** The resource a returned `null` names in its 404 ("" for a generic "Not found"). */
    readonly resource: string = "",
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
  private readonly authenticate: Authenticate | null;
  readonly locale: string;
  /** Open requests, streams and WebSockets of the running server (see `shutdown`). */
  readonly lifecycle = new Lifecycle();
  private readonly shutdownHooks: ShutdownHook[] = [];
  private shutdownPromise: Promise<boolean> | null = null;
  private readonly health: boolean;
  private readonly readyTimeout: number;
  private readonly requestIds: boolean;

  constructor(options: AppOptions) {
    this.container = new Container(options.providers ?? []);
    this.middleware = options.middleware ?? [];
    this.onError = options.onError ?? null;
    this.logger = options.logger ?? new Logger();
    this.exposeErrors = options.exposeErrors ?? false;
    this.authenticate = options.authenticate ?? null;
    this.locale = options.locale ?? "en";
    this.health = options.health ?? true;
    this.readyTimeout = options.readyTimeout ?? 1000;
    this.requestIds = options.requestId ?? true;
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
          throw new Error(`${entry.name}.${name}: action() is only for index/show/store/update/destroy; use get()/post()/put()/patch()/del() with a path for other routes, e.g. ${name}: post("/${name}", {}, ...) in the ${entry.name} controller (qala generate reports the exact file and line)`);
        }
        method = conventional[0];
        path = conventional[1];
      }
      const full = joinPath(entry.prefix, path);
      const index = this.routes.length;
      const auth = def.auth !== "" ? def.auth : entry.controller.auth ? "required" : "";
      this.routes.push(new Route(method, full, entry.name, name, def, entry.controller.middleware, auth, entry.controller.resourceName));
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

  /** Runs `hook` during `shutdown()`, after in-flight requests finished and before the database closes. */
  onShutdown(hook: ShutdownHook): void {
    this.shutdownHooks.push(hook);
  }

  /** True once `shutdown()` started. */
  get shuttingDown(): boolean {
    return this.lifecycle.draining;
  }

  /**
   * Graceful shutdown: stop accepting connections, close idle keep-alive connections, close WebSockets (1001) and
   * streams, wait up to `timeout` ms for in-flight requests, run `onShutdown` hooks (last registered first), then
   * close the database pool. Resolves true if everything drained in time. Safe to call more than once.
   * `serve()` calls it on SIGTERM/SIGINT and then exits.
   */
  shutdown(timeout = 10000): Promise<boolean> {
    if (this.shutdownPromise === null) this.shutdownPromise = this.runShutdown(timeout);
    return this.shutdownPromise;
  }

  private async runShutdown(timeout: number): Promise<boolean> {
    const life = this.lifecycle;
    this.logger.info("Shutting down", { inflight: life.inflight, websockets: life.openSockets, streams: life.openStreams });
    life.stop();
    const drained = await life.idle(timeout);
    if (!drained) this.logger.warn(`Shutdown timeout: ${timeout} ms passed with requests still in flight`, { inflight: life.inflight, websockets: life.openSockets });
    for (let i = this.shutdownHooks.length - 1; i >= 0; i--) {
      try {
        await this.shutdownHooks[i]!();
      } catch (error) {
        this.logger.error("Shutdown hook failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
    const db = this.container.peek(Database);
    if (db !== null) db.close();
    this.logger.info("Shutdown complete");
    return drained;
  }

  /** Handles one request; never throws. */
  async handle(request: RequestData): Promise<Reply> {
    const { path, query } = splitUrl(request.url);
    const ctx = this.context(request, path);
    ctx.query = query;
    let reply: Reply;
    try {
      const probe = this.health ? await this.probe(ctx) : null;
      reply = probe !== null ? probe : await compose(this.middleware, ctx, () => this.dispatch(ctx));
    } catch (error) {
      reply = await this.errorReply(error, ctx);
    }
    const headerNames = Object.keys(ctx.responseHeaders);
    if (headerNames.length === 0 && ctx.responseCookies.length === 0) return reply;
    const headers: Record<string, string> = {};
    for (const key of headerNames) headers[key] = ctx.responseHeaders[key]!;
    for (const key of Object.keys(reply.headers)) headers[key] = reply.headers[key]!;
    const cookies = [...reply.cookies, ...ctx.responseCookies];
    if (reply instanceof StreamReply) return new StreamReply(reply.status, headers, reply.start, cookies);
    return new Reply(reply.status, reply.body, headers, cookies);
  }

  /** Whether any controller declares a WebSocket route. */
  hasWebSockets(): boolean {
    for (const r of this.routes) if (r.method === "WS") return true;
    return false;
  }

  /**
   * Decides a WebSocket upgrade: the request runs through the global and the route's middleware (auth, CORS) and,
   * if they let it through, the route's handlers are returned with the request context; otherwise the reply to send.
   */
  async upgrade(request: RequestData): Promise<Upgrade> {
    const { path, query } = splitUrl(request.url);
    const ctx = this.context(request, path);
    ctx.query = query;
    const match = this.router.find("WS", path);
    const accepted: { handlers: WsHandlers | null } = { handlers: null };
    let reply: Reply;
    try {
      if (match === null) throw new NotFoundError(`No WebSocket route for ${path}`);
      const route = this.routes[match.route]!;
      ctx.params = match.params;
      const handlers = route.def.socket;
      reply = await compose(this.middleware, ctx, () =>
        compose(route.middleware, ctx, async () => {
          accepted.handlers = handlers;
          return new Reply(101, "", {});
        }),
      );
    } catch (error) {
      accepted.handlers = null;
      reply = await this.errorReply(error, ctx);
    }
    const handlers = accepted.handlers;
    if (handlers !== null && reply.status === 101) return new Upgrade(handlers, ctx, null);
    const headers: Record<string, string> = {};
    for (const key of Object.keys(ctx.responseHeaders)) headers[key] = ctx.responseHeaders[key]!;
    for (const key of Object.keys(reply.headers)) headers[key] = reply.headers[key]!;
    return new Upgrade(null, ctx, new Reply(reply.status, reply.body, headers, [...reply.cookies, ...ctx.responseCookies]));
  }

  private context(request: RequestData, path: string): Context {
    const ctx = new Context(request, path, this.container);
    ctx.logger = this.logger;
    if (this.requestIds) {
      const incoming = request.headers["x-request-id"];
      ctx.requestId = incoming !== undefined && validRequestId(incoming) ? incoming : randomBytes(16).toString("hex");
      ctx.setHeader("x-request-id", ctx.requestId);
    }
    return ctx;
  }

  /** `/health` and `/ready`, answered before middleware (so probes skip auth and request logs), unless a route claims the path. */
  private async probe(ctx: Context): Promise<Reply | null> {
    const path = ctx.path;
    if (path !== "/health" && path !== "/ready") return null;
    if (ctx.method !== "GET" && ctx.method !== "HEAD") return null;
    if (this.router.find("GET", path) !== null) return null;
    ctx.setHeader("cache-control", "no-store");
    if (path === "/health") return json({ status: "ok" });
    if (this.shuttingDown) return json({ status: "shutting_down" }, 503);
    if (this.container.has(Database)) {
      const up = await pingDatabase(this.container.get(Database), this.readyTimeout);
      if (!up) {
        ctx.log.warn("Readiness check failed: database did not answer", { timeout_ms: this.readyTimeout });
        return json({ status: "unavailable", checks: { database: "down" } }, 503);
      }
      return json({ status: "ready", checks: { database: "up" } });
    }
    return json({ status: "ready" });
  }

  private async dispatch(ctx: Context): Promise<Reply> {
    const match = this.router.find(ctx.method === "HEAD" ? "GET" : ctx.method, ctx.path);
    if (match === null) {
      const allowed = this.router.methodsFor(ctx.path).filter((m) => m !== "WS");
      if (allowed.length === 0 && this.router.find("WS", ctx.path) !== null) {
        ctx.setHeader("upgrade", "websocket");
        throw new HttpError(426, "WebSocket upgrade required", "upgrade_required");
      }
      if (allowed.length > 0) {
        ctx.setHeader("allow", allowed.join(", "));
        throw new HttpError(405, `Method ${ctx.method} not allowed`, "method_not_allowed", null, true, { method: ctx.method });
      }
      throw new HttpError(404, `No route for ${ctx.method} ${ctx.path}`, "not_found", null, true, { key: "route_not_found", method: ctx.method, path: ctx.path });
    }
    const route = this.routes[match.route]!;
    ctx.params = match.params;
    return compose(route.middleware, ctx, () => this.run(route, ctx));
  }

  private async run(route: Route, ctx: Context): Promise<Reply> {
    const def = route.def;
    const input: RuntimeInput = { params: ctx.params, query: ctx.query, body: undefined, files: [], id: ctx.params["id"] ?? "", user: null, ctx };
    if (route.auth !== "") {
      if (this.authenticate === null) throw new Error(`${route.controller}.${route.action} needs authentication but the app has no authenticate hook. Fix: export async function authenticate(ctx: Context) from app/auth.ts and run qala generate, or drop auth: true from the action`);
      const user = await this.authenticate(ctx);
      if (user === null || user === undefined) {
        if (route.auth === "required") throw new UnauthorizedError();
      } else {
        input.user = user;
        ctx.set(USER_KEY, user);
      }
    }
    if (def.params !== null) input.params = check(def.params, ctx.params, true, "route parameters");
    if (def.query !== null) input.query = check(def.query, ctx.query, true, "query");
    if (def.body !== null || def.multipart !== null) {
      const parsed = readBody(ctx, def.multipart);
      input.files = parsed.files;
      input.body = def.body === null ? parsed.value : check(def.body, parsed.value, parsed.form, "body");
    }
    const reply = await def.handler(input);
    if (reply.kind === "missing") {
      if (route.resource === "") throw new NotFoundError();
      throw new HttpError(404, `${route.resource} not found`, "not_found", null, true, { key: "resource_not_found", resource: route.resource });
    }
    if (reply.kind === "implicit" && reply.status === 200 && def.method === "" && route.action === "store") {
      return new Reply(201, reply.body, reply.headers, reply.cookies);
    }
    return reply;
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
    const locale = pickLocale(ctx.header("accept-language"), this.locale);
    if (error instanceof DatabaseError) {
      const mapped = databaseHttpError(error);
      if (mapped !== null) error = mapped;
    }
    if (error instanceof ValidationError) {
      return errorBody(error.status, error.code, translate("validation_failed", error.params, locale, error.message), translateIssues(error.issues, locale));
    }
    if (error instanceof HttpError) {
      if (error.status >= 500) this.logger.error(error.message, errorFields(ctx, error.status, ""));
      const message = error.translatable ? translate(error.params["key"] ?? error.code, error.params, locale, error.message) : error.message;
      return errorBody(error.status, error.code, message, error.details);
    }
    if (error instanceof DomainError) return errorBody(422, error.code, error.message, null);
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack ?? "") : "";
    this.logger.error(`Unhandled error: ${message}`, errorFields(ctx, 500, stack));
    return errorBody(500, "internal_error", this.exposeErrors ? message : translate("internal_error", {}, locale, "Internal server error"), this.exposeErrors ? stack : null);
  }
}

/** The fields of an error log line: request_id, method, path, status, duration_ms (and the stack, if any). */
function errorFields(ctx: Context, status: number, stack: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (ctx.requestId !== "") fields["request_id"] = ctx.requestId;
  fields["method"] = ctx.method;
  fields["path"] = ctx.path;
  fields["status"] = status;
  fields["duration_ms"] = Date.now() - ctx.startedAt;
  if (stack !== "") fields["stack"] = stack;
  return fields;
}

/** Resolves true if the database answers `select 1` within `timeout` ms, false on error or timeout. */
function pingDatabase(db: Database, timeout: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeout);
    db.query("select 1", []).then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

/** `email_address` → `emailAddress` (models expose camelCase fields). */
function camel(column: string): string {
  return column.replace(/_([a-z0-9])/g, (_m: string, c: string) => c.toUpperCase());
}

/** The columns named in a Postgres error detail: `Key (project_id, title)=(…) already exists.` → camelCase names. */
function keyFields(detail: string): string[] {
  const m = /Key \(([^)]*)\)=/.exec(detail);
  if (m === null) return [];
  const out: string[] = [];
  for (const part of (m[1] ?? "").split(",")) {
    const name = part.trim().replace(/^"|"$/g, "");
    if (name !== "") out.push(camel(name));
  }
  return out;
}

/** Constraint violations as client errors: unique → 409, foreign key → 400, not null → 422, bad input syntax → 400. */
function databaseHttpError(error: DatabaseError): HttpError | null {
  if (error.code === "23505" || error.code === "23503") {
    const fields = keyFields(error.detail);
    const unique = error.code === "23505";
    const field = fields.join(", ");
    const key = (unique ? "unique_violation" : "foreign_key_violation") + (field === "" ? "_generic" : "");
    const english = unique ? (field === "" ? "Already exists" : `${field} already exists`) : field === "" ? "Refers to a missing record" : `${field} refers to a missing record`;
    return new HttpError(unique ? 409 : 400, english, unique ? "unique_violation" : "foreign_key_violation", { constraint: error.constraint, fields }, true, { key, field });
  }
  if (error.code === "23502") {
    const field = camel(error.column);
    return new HttpError(422, `${field} is required`, "not_null_violation", { field }, true, { field });
  }
  if (error.code === "22P02") return new HttpError(400, "Invalid value", "invalid_input", null, true);
  return null;
}

/** Validation issues with their messages in `locale` (author-written `custom` messages stay as they are). */
function translateIssues(issues: Issue[], locale: string): Issue[] {
  const out: Issue[] = [];
  for (const issue of issues) {
    const code = issue.code;
    if (code === undefined || code === "custom") {
      out.push({ path: issue.path, message: issue.message });
      continue;
    }
    out.push({ path: issue.path, message: translate(code, issue.params ?? {}, locale, issue.message) });
  }
  return out;
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

/** The outcome of `App.upgrade`: accepted (`handlers`) or refused (`reply`). */
export class Upgrade {
  constructor(
    readonly handlers: WsHandlers | null,
    readonly ctx: Context,
    readonly reply: Reply | null,
  ) {}
}

export function createApp(options: AppOptions): App {
  return new App(options);
}

export { RequestData };
