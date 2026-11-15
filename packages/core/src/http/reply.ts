/**
 * What a handler sends back. Handlers may also return a plain value (sent as JSON with 200);
 * `Reply` is for other status codes and headers. `B` is the body type, kept for the typed client.
 */
export class Reply {
  constructor(
    readonly status: number,
    /** Already-serialised body (JSON text, plain text or empty). */
    readonly body: string,
    readonly headers: Record<string, string>,
    /** `Set-Cookie` header values: one entry per cookie (they cannot be joined into one header). */
    readonly cookies: string[] = [],
  ) {}
}

export type TypedReply<B> = Reply & { readonly __body?: () => B };

const JSON_TYPE = "application/json; charset=utf-8";

export function json<B>(body: B, status = 200, headers: Record<string, string> = {}): TypedReply<B> {
  const all: Record<string, string> = { "content-type": JSON_TYPE };
  for (const key of Object.keys(headers)) all[key.toLowerCase()] = headers[key]!;
  return new Reply(status, JSON.stringify(body) ?? "null", all);
}

/** 201 Created with the new resource as the body. */
export function created<B>(body: B, location?: string): TypedReply<B> {
  return json(body, 201, location === undefined ? {} : { location });
}

/** 204 No Content. */
export function noContent(): TypedReply<null> {
  return new Reply(204, "", {});
}

export function text(body: string, status = 200, contentType = "text/plain; charset=utf-8"): TypedReply<string> {
  return new Reply(status, body, { "content-type": contentType });
}

export function redirect(location: string, status = 302): TypedReply<null> {
  return new Reply(status, "", { location });
}
