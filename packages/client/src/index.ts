/**
 * @qala/client — a typed HTTP client for a Qala API (end-to-end type safety, like Elysia's Eden).
 *
 *   import { createClient } from "@qala/client";
 *   import { manifest, type Api } from "../backend/.qala/api";
 *
 *   const api = createClient<Api>({ baseUrl: "http://localhost:3000", manifest });
 *   const task = await api.tasks.show({ params: { id } });   // fully typed input and result
 *
 * Runs in browsers, Bun and Node; it imports only types from @qala/core.
 */
import type { ResultOf } from "@qala/core";

// ─── JSON shape of a result ──────────────────────────────────────────────────

/** Resolves intersections and mapped types into one plain object type. */
type Flat<T> = { [K in keyof T]: T[K] };
type JsonPrimitive = string | number | boolean | null;
type DropKey<V> = [V] extends [undefined] ? true : [V] extends [(...args: never[]) => unknown] ? true : [V] extends [symbol] ? true : false;
type JsonifyElement<T> = T extends undefined | ((...args: never[]) => unknown) | symbol ? null : Jsonify<T>;

/** What `JSON.parse(JSON.stringify(value))` gives back, as a type (Date → string, functions and undefined fields dropped). */
export type Jsonify<T> = T extends JsonPrimitive
  ? T
  : T extends undefined | void
    ? undefined
    : T extends { toJSON(): infer J }
      ? Jsonify<J>
      : T extends (...args: never[]) => unknown
        ? never
        : T extends readonly (infer E)[]
          ? JsonifyElement<E>[]
          : T extends ReadonlyMap<unknown, unknown> | ReadonlySet<unknown>
            ? Record<string, never>
            : T extends object
              ? Flat<{ [K in keyof T as K extends symbol ? never : DropKey<T[K]> extends true ? never : K]: Jsonify<T[K]> }>
              : never;

/** A top-level result: an empty response (`undefined`/`void`, 204) arrives as `null`. */
type Output<R> = [ResultOf<R>] extends [undefined | void] ? null : Jsonify<ResultOf<R>>;

// ─── Reading the API type ────────────────────────────────────────────────────

type ActionsOf<C> = C extends { readonly __actions?: () => infer A } ? A : never;
type ActionInfo<X> = X extends { readonly __action?: () => infer I } ? I : never;

type HasKeys<T> = string extends keyof T ? false : [keyof T] extends [never] ? false : true;

type ParamsPart<P> = HasKeys<P> extends true ? { params: Flat<P> } : {};
type QueryPart<Q> = HasKeys<Q> extends false ? {} : {} extends Q ? { query?: Flat<Q> } : { query: Flat<Q> };
type BodyPart<B> = [B] extends [undefined] ? {} : undefined extends B ? { body?: Flat<B> } : { body: Flat<B> };

/** The input object of one action: `params`/`query`/`body` exactly as the action declares them. */
export type ActionInput<I> = I extends { params: infer P; query: infer Q; body: infer B } ? Flat<ParamsPart<P> & QueryPart<Q> & BodyPart<B>> : never;
/** What one action resolves to. */
export type ActionOutput<I> = I extends { result: infer R } ? Output<R> : never;

export type CallOptions = {
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

type Call<I> = {} extends ActionInput<I>
  ? (input?: ActionInput<I>, options?: CallOptions) => Promise<ActionOutput<I>>
  : (input: ActionInput<I>, options?: CallOptions) => Promise<ActionOutput<I>>;

/** The client for an API: `client.<controller>.<action>(input)`. */
export type Client<Api> = {
  [C in keyof Api]: { [A in keyof ActionsOf<Api[C]>]: Call<ActionInfo<ActionsOf<Api[C]>[A]>> };
};

// ─── Runtime ─────────────────────────────────────────────────────────────────

/** `{ controller: { action: [method, path] } }`, generated as `manifest` in `.qala/api.ts`. */
export type Manifest = { readonly [controller: string]: { readonly [action: string]: readonly [string, string] } };

export type TransportRequest = { method: string; url: string; headers: Record<string, string>; body: string; signal?: AbortSignal };
export type TransportResponse = { status: number; body: string };
/** How requests are sent: `fetch` by default; tests can call `app.handle` in-process instead. */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export type ClientOptions = {
  baseUrl: string;
  manifest: Manifest;
  /** Headers for every request, e.g. `() => ({ authorization: \`Bearer ${token}\` })`. */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  transport?: Transport;
};

/** A non-2xx response. `code`/`message`/`details` come from Qala's `{ error: {...} }` body. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown,
    /** The parsed response body (or its text if it was not JSON). */
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const fetchTransport: Transport = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body === "" ? undefined : req.body,
    signal: req.signal,
  });
  return { status: res.status, body: await res.text() };
};

type RawInput = { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown };

/** Builds `baseUrl + path` with `:params` filled in and the defined query values appended. */
export function buildUrl(baseUrl: string, path: string, params: Record<string, unknown> | undefined, query: Record<string, unknown> | undefined): string {
  const filled = path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => {
    const value = params?.[name];
    if (value === undefined || value === null) throw new Error(`Missing path parameter :${name} for ${path}`);
    return encodeURIComponent(String(value));
  });
  const parts: string[] = [];
  if (query !== undefined) {
    for (const key of Object.keys(query)) {
      const value = query[key];
      if (value === undefined || value === null) continue;
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return `${baseUrl.replace(/\/+$/, "")}${filled}${parts.length > 0 ? `?${parts.join("&")}` : ""}`;
}

function parse(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function toError(status: number, text: string): ApiError {
  const body = parse(text);
  if (typeof body === "object" && body !== null && "error" in body) {
    const e = (body as { error: unknown }).error;
    if (typeof e === "object" && e !== null) {
      const err = e as { code?: unknown; message?: unknown; details?: unknown };
      return new ApiError(status, typeof err.code === "string" ? err.code : "http_error", typeof err.message === "string" ? err.message : `HTTP ${status}`, err.details ?? null, body);
    }
  }
  return new ApiError(status, "http_error", `HTTP ${status}`, null, body);
}

/** Creates the typed client for `Api` (the `Api` type generated in `.qala/api.ts`). */
export function createClient<Api>(options: ClientOptions): Client<Api> {
  const transport = options.transport ?? fetchTransport;
  const client: Record<string, Record<string, (input?: RawInput, call?: CallOptions) => Promise<unknown>>> = {};
  for (const controller of Object.keys(options.manifest)) {
    const actions = options.manifest[controller]!;
    const group: Record<string, (input?: RawInput, call?: CallOptions) => Promise<unknown>> = {};
    for (const name of Object.keys(actions)) {
      const [method, path] = actions[name]!;
      group[name] = async (input = {}, call = {}) => {
        const base = typeof options.headers === "function" ? await options.headers() : (options.headers ?? {});
        const headers: Record<string, string> = { accept: "application/json", ...base };
        const body = input.body === undefined ? "" : JSON.stringify(input.body);
        if (body !== "") headers["content-type"] = "application/json";
        Object.assign(headers, call.headers);
        const res = await transport({ method, url: buildUrl(options.baseUrl, path, input.params, input.query), headers, body, signal: call.signal });
        if (res.status < 200 || res.status >= 300) throw toError(res.status, res.body);
        return res.status === 204 ? null : parse(res.body);
      };
    }
    client[controller] = group;
  }
  return client as unknown as Client<Api>;
}
