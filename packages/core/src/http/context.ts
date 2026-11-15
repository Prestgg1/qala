/** One incoming request as the framework sees it (independent of the HTTP server underneath). */
export class RequestData {
  constructor(
    readonly method: string,
    /** Path and query string, e.g. `/tasks?done=true`. */
    readonly url: string,
    /** Lower-cased header names. */
    readonly headers: Record<string, string>,
    readonly body: string,
    readonly ip: string,
  ) {}
}

/**
 * The request context middleware and handlers share: the raw request, route params, query and
 * a per-request store (`ctx.set("user", user)`), e.g. for authentication results.
 */
export class Context {
  /** Validated params/query/body, set before the handler runs. */
  params: Record<string, string> = {};
  query: Record<string, string> = {};
  /** Response headers added by middleware or handlers. */
  readonly responseHeaders: Record<string, string> = {};
  private readonly store = new Map<string, unknown>();
  readonly startedAt = Date.now();

  constructor(
    readonly request: RequestData,
    readonly path: string,
  ) {}

  get method(): string {
    return this.request.method;
  }

  header(name: string): string | undefined {
    return this.request.headers[name.toLowerCase()];
  }

  /** The bearer token of the `Authorization` header, if any. */
  bearer(): string | undefined {
    const value = this.header("authorization");
    if (value === undefined || !value.toLowerCase().startsWith("bearer ")) return undefined;
    return value.slice(7).trim();
  }

  set(key: string, value: unknown): void {
    this.store.set(key, value);
  }

  get(key: string): unknown {
    return this.store.get(key);
  }

  setHeader(name: string, value: string): void {
    this.responseHeaders[name.toLowerCase()] = value;
  }
}

/** Splits `/a/b?x=1&y=2` into path and decoded query values. */
export function splitUrl(url: string): { path: string; query: Record<string, string> } {
  const mark = url.indexOf("?");
  const rawPath = mark === -1 ? url : url.slice(0, mark);
  const query: Record<string, string> = {};
  if (mark !== -1) {
    for (const pair of url.slice(mark + 1).split("&")) {
      if (pair === "") continue;
      const eq = pair.indexOf("=");
      const key = decode(eq === -1 ? pair : pair.slice(0, eq));
      query[key] = eq === -1 ? "" : decode(pair.slice(eq + 1));
    }
  }
  let path = rawPath === "" ? "/" : rawPath;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return { path, query };
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}
