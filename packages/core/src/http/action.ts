import { SchemaNode, type Infer, type Shape, type InferShape, t } from "../schema";
import type { AppUser } from "./auth";
import type { Context } from "./context";
import { MultipartLimits, type UploadedFile } from "./multipart";
import { json, Reply, type TypedReply } from "./reply";
import type { WsHandlers } from "./websocket";

/** What an action's input schemas look like: a shape (`{ id: t.uuid() }`) or a full schema. */
export type InputSchemas = {
  params?: Shape;
  query?: Shape;
  body?: SchemaNode;
  /**
   * Accept `multipart/form-data` uploads (JSON bodies still work). The handler receives the uploaded `files`;
   * `body` (if declared, a `t.object(...)`) validates the text fields, with strings coerced like query values.
   * `true` or limits: `{ maxFileSize: 5_000_000, maxFiles: 3 }` (bytes / count).
   */
  files?: true | { maxFileSize?: number; maxFiles?: number };
  /**
   * Run the app's `authenticate` (from `app/auth.ts`) first: `true` requires a user (401 otherwise) and types
   * the handler's `user` as `AppUser`; `"optional"` passes `AppUser | null`.
   */
  auth?: true | "optional";
};

type ParamsOf<I, Default> = I extends { params: infer P extends Shape } ? InferShape<P> : Default;
/** Without a query schema the handler sees the raw query string values (honest: scriptc checks it at run time). */
type QueryOf<I> = I extends { query: infer Q extends Shape } ? InferShape<Q> : Record<string, string>;
// Without a body schema an upload action still receives the raw multipart fields (or any JSON body),
// so its body is `unknown` (honest for scriptc's run-time type checks); other actions get `undefined`.
type UserOf<I> = I extends { auth: true } ? AppUser : AppUser | null;
type BodyOf<I> = I extends { body: infer B extends SchemaNode } ? Infer<B> : I extends { files: true | object } ? unknown : undefined;

/** The validated input a handler receives, plus the raw request context as `ctx`. */
export type Input<I, DefaultParams> = {
  params: ParamsOf<I, DefaultParams>;
  query: QueryOf<I>;
  body: BodyOf<I>;
  /** Uploaded files of a multipart request (empty for other bodies). */
  files: UploadedFile[];
  /** The `:id` route parameter ("" on routes without one), so conventional handlers can write `({ id }) => …`. */
  id: string;
  /** The authenticated user: `AppUser` with `auth: true`, otherwise `AppUser | null` (null unless authenticated). */
  user: UserOf<I>;
  ctx: Context;
};

/** A route action at run time (one non-generic class; the types live in `Action`). */
export class ActionDef {
  constructor(
    /** "" for conventional resource actions (index/show/store/update/destroy): the method comes from the name. */
    readonly method: string,
    /** Path relative to the controller prefix, "" for conventional actions. */
    readonly path: string,
    readonly params: SchemaNode | null,
    readonly query: SchemaNode | null,
    readonly body: SchemaNode | null,
    readonly handler: RuntimeHandler,
    /** Multipart limits when the action accepts uploads, otherwise null. */
    readonly multipart: MultipartLimits | null = null,
    /** The callbacks of a WebSocket route (method "WS"), otherwise null. */
    readonly socket: WsHandlers | null = null,
    /** "required" / "optional" when the action itself asks for authentication, "" otherwise. */
    readonly auth: string = "",
  ) {}
}

export type RuntimeInput = { params: unknown; query: unknown; body: unknown; files: UploadedFile[]; id: string; user: unknown; ctx: Context };
/** A handler as the app runs it: validated input in, finished `Reply` out. */
export type RuntimeHandler = (input: RuntimeInput) => Promise<Reply>;

/**
 * The typed view of an action, used by the client: `P`/`Q`/`B` are the inputs, `R` what the handler returns.
 */
export type Action<P, Q, B, R> = ActionDef & { readonly __action?: () => { params: P; query: Q; body: B; result: R } };

function shapeSchema(shape: Shape | undefined): SchemaNode | null {
  return shape === undefined ? null : t.object(shape);
}

function multipartLimits(files: true | { maxFileSize?: number; maxFiles?: number } | undefined): MultipartLimits | null {
  if (files === undefined) return null;
  if (files === true) return new MultipartLimits(0, 0);
  return new MultipartLimits(files.maxFileSize ?? 0, files.maxFiles ?? 0);
}

function make(method: string, path: string, input: InputSchemas, handler: RuntimeHandler): ActionDef {
  const auth = input.auth === true ? "required" : input.auth === "optional" ? "optional" : "";
  return new ActionDef(method, path, shapeSchema(input.params), shapeSchema(input.query), input.body ?? null, handler, multipartLimits(input.files), null, auth);
}

/**
 * Turns a handler's result into a `Reply` while its type is still known, so the JSON serialisation is
 * compiled for that type (scriptc specialises generic functions) instead of walking an `unknown` value.
 *
 * Conventions: `undefined` → 204, `null` → 404 (the app names the missing resource), any other value → 200
 * JSON (201 for a conventional `store`, decided by the app from the `implicit` kind).
 */
export function toReply<T>(value: T): Reply {
  // Checked through an `unknown` view: narrowing a specialised `T` to `Reply` does not compile.
  const any: unknown = value;
  if (any instanceof Reply) return any;
  if (any === undefined) return new Reply(204, "", {}, [], "implicit");
  if (any === null) return new Reply(404, "", {}, [], "missing");
  const reply = json(value);
  return new Reply(reply.status, reply.body, reply.headers, [], "implicit");
}

/**
 * A handler result type with `void` spelled `undefined` (also inside a promise): a `void` function returns
 * `undefined` at run time, and scriptc cannot hold a value typed `void`.
 */
type Unvoid<R> = R extends Promise<infer U> ? Promise<[U] extends [void] ? undefined : U> : [R] extends [void] ? undefined : R;

/** Wraps a typed handler as a `RuntimeHandler` (one specialisation per handler type). */
function wrap<A, R>(handler: (input: A) => R): RuntimeHandler {
  return wrapTyped<A, Unvoid<R>>(handler as unknown as (input: A) => Unvoid<R>);
}

function wrapTyped<A, R>(handler: (input: A) => R): RuntimeHandler {
  return async (input) => {
    const result = await handler(input as A);
    return toReply(result);
  };
}

/**
 * Conventional resource action: its method and path come from its name (index, show, store, update, destroy).
 * Declare `params: { id: t.uuid() }` for show/update/destroy to get a typed, validated `params.id`.
 */
export function action<const I extends InputSchemas, R>(input: I, handler: (input: Input<I, Record<string, string>>) => R): Action<ParamsOf<I, Record<string, string>>, QueryOf<I>, BodyOf<I>, R> {
  return make("", "", input, wrap(handler));
}

type PathParams<Path extends string> = Path extends `${string}:${infer P}/${infer Rest}` ? { [K in P]: string } & PathParams<`/${Rest}`> : Path extends `${string}:${infer P}` ? { [K in P]: string } : {};

type Verb<Path extends string, I, R> = Action<ParamsOf<I, PathParams<Path>>, QueryOf<I>, BodyOf<I>, R>;
type VerbHandler<Path extends string, I, R> = (input: Input<I, PathParams<Path>>) => R;

/** Custom routes, relative to the controller's prefix: `get("/:id/history", {}, ...)`. */
export function get<const Path extends string, const I extends InputSchemas, R>(path: Path, input: I, handler: VerbHandler<Path, I, R>): Verb<Path, I, R> {
  return make("GET", path, input, wrap(handler));
}
export function post<const Path extends string, const I extends InputSchemas, R>(path: Path, input: I, handler: VerbHandler<Path, I, R>): Verb<Path, I, R> {
  return make("POST", path, input, wrap(handler));
}
export function put<const Path extends string, const I extends InputSchemas, R>(path: Path, input: I, handler: VerbHandler<Path, I, R>): Verb<Path, I, R> {
  return make("PUT", path, input, wrap(handler));
}
export function patch<const Path extends string, const I extends InputSchemas, R>(path: Path, input: I, handler: VerbHandler<Path, I, R>): Verb<Path, I, R> {
  return make("PATCH", path, input, wrap(handler));
}
export function del<const Path extends string, const I extends InputSchemas, R>(path: Path, input: I, handler: VerbHandler<Path, I, R>): Verb<Path, I, R> {
  return make("DELETE", path, input, wrap(handler));
}

type WireOf<A> = A extends TypedReply<infer B> ? B : A extends Reply ? unknown : A;
/**
 * What an action resolves to on the wire: the body of a `Reply`, or the returned value itself. A returned
 * `null` never reaches the client (it is a 404), so it is not part of the result.
 */
export type ResultOf<R> = WireOf<Exclude<Awaited<R>, null>>;
