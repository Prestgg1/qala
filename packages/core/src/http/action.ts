import { SchemaNode, type Infer, type Shape, type InferShape, t } from "../schema";
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
};

type ParamsOf<I, Default> = I extends { params: infer P extends Shape } ? InferShape<P> : Default;
/** Without a query schema the handler sees the raw query string values (honest: scriptc checks it at run time). */
type QueryOf<I> = I extends { query: infer Q extends Shape } ? InferShape<Q> : Record<string, string>;
type BodyOf<I> = I extends { body: infer B extends SchemaNode } ? Infer<B> : undefined;

/** The validated input a handler receives, plus the raw request context as `ctx`. */
export type Input<I, DefaultParams> = {
  params: ParamsOf<I, DefaultParams>;
  query: QueryOf<I>;
  body: BodyOf<I>;
  /** Uploaded files of a multipart request (empty for other bodies). */
  files: UploadedFile[];
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
  ) {}
}

export type RuntimeInput = { params: unknown; query: unknown; body: unknown; files: UploadedFile[]; ctx: Context };
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
  return new ActionDef(method, path, shapeSchema(input.params), shapeSchema(input.query), input.body ?? null, handler, multipartLimits(input.files));
}

/**
 * Turns a handler's result into a `Reply` while its type is still known, so the JSON serialisation is
 * compiled for that type (scriptc specialises generic functions) instead of walking an `unknown` value.
 */
export function toReply<T>(value: T): Reply {
  // Checked through an `unknown` view: narrowing a specialised `T` to `Reply` does not compile.
  const any: unknown = value;
  if (any instanceof Reply) return any;
  if (any === undefined) return new Reply(204, "", {});
  return json(value);
}

/** Wraps a typed handler as a `RuntimeHandler` (one specialisation per handler type). */
function wrap<A, R>(handler: (input: A) => R): RuntimeHandler {
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

/** What an action resolves to on the wire: the body of a `Reply`, or the returned value itself. */
export type ResultOf<R> = Awaited<R> extends TypedReply<infer B> ? B : Awaited<R> extends Reply ? unknown : Awaited<R>;
