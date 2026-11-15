import { SchemaNode, type Infer, type Shape, type InferShape, t } from "../schema";
import type { Context } from "./context";
import type { Reply, TypedReply } from "./reply";

/** What an action's input schemas look like: a shape (`{ id: t.uuid() }`) or a full schema. */
export type InputSchemas = {
  params?: Shape;
  query?: Shape;
  body?: SchemaNode;
};

type ParamsOf<I, Default> = I extends { params: infer P extends Shape } ? InferShape<P> : Default;
type QueryOf<I> = I extends { query: infer Q extends Shape } ? InferShape<Q> : Record<string, never>;
type BodyOf<I> = I extends { body: infer B extends SchemaNode } ? Infer<B> : undefined;

/** The validated input a handler receives, plus the raw request context as `ctx`. */
export type Input<I, DefaultParams> = {
  params: ParamsOf<I, DefaultParams>;
  query: QueryOf<I>;
  body: BodyOf<I>;
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
  ) {}
}

export type RuntimeInput = { params: unknown; query: unknown; body: unknown; ctx: Context };
export type RuntimeHandler = (input: RuntimeInput) => unknown;

/**
 * The typed view of an action, used by the client: `P`/`Q`/`B` are the inputs, `R` what the handler returns.
 */
export type Action<P, Q, B, R> = ActionDef & { readonly __action?: () => { params: P; query: Q; body: B; result: R } };

function shapeSchema(shape: Shape | undefined): SchemaNode | null {
  return shape === undefined ? null : t.object(shape);
}

function make(method: string, path: string, input: InputSchemas, handler: unknown): ActionDef {
  return new ActionDef(method, path, shapeSchema(input.params), shapeSchema(input.query), input.body ?? null, handler as RuntimeHandler);
}

/**
 * Conventional resource action: its method and path come from its name (index, show, store, update, destroy).
 * Declare `params: { id: t.uuid() }` for show/update/destroy to get a typed, validated `params.id`.
 */
export function action<const I extends InputSchemas, R>(input: I, handler: (input: Input<I, Record<string, string>>) => R): Action<ParamsOf<I, Record<string, string>>, QueryOf<I>, BodyOf<I>, R> {
  return make("", "", input, handler);
}

type PathParams<Path extends string> = Path extends `${string}:${infer P}/${infer Rest}` ? { [K in P]: string } & PathParams<`/${Rest}`> : Path extends `${string}:${infer P}` ? { [K in P]: string } : Record<string, never>;

type Verb<Path extends string, I, R> = Action<ParamsOf<I, PathParams<Path>>, QueryOf<I>, BodyOf<I>, R>;
type VerbHandler<Path extends string, I, R> = (input: Input<I, PathParams<Path>>) => R;

/** Custom routes, relative to the controller's prefix: `get("/:id/history", {}, ...)`. */
export function get<const Path extends string, const I extends InputSchemas, R>(path: Path, input: I, handler: VerbHandler<Path, I, R>): Verb<Path, I, R> {
  return make("GET", path, input, handler);
}
export function post<const Path extends string, const I extends InputSchemas, R>(path: Path, input: I, handler: VerbHandler<Path, I, R>): Verb<Path, I, R> {
  return make("POST", path, input, handler);
}
export function put<const Path extends string, const I extends InputSchemas, R>(path: Path, input: I, handler: VerbHandler<Path, I, R>): Verb<Path, I, R> {
  return make("PUT", path, input, handler);
}
export function patch<const Path extends string, const I extends InputSchemas, R>(path: Path, input: I, handler: VerbHandler<Path, I, R>): Verb<Path, I, R> {
  return make("PATCH", path, input, handler);
}
export function del<const Path extends string, const I extends InputSchemas, R>(path: Path, input: I, handler: VerbHandler<Path, I, R>): Verb<Path, I, R> {
  return make("DELETE", path, input, handler);
}

/** What an action resolves to on the wire: the body of a `Reply`, or the returned value itself. */
export type ResultOf<R> = Awaited<R> extends TypedReply<infer B> ? B : Awaited<R> extends Reply ? unknown : Awaited<R>;
