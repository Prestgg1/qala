import type { ServerResponse } from "node:http";
import type { Context } from "./context";
import { Reply } from "./reply";

/** Where a stream's bytes go: the HTTP server underneath supplies it (node:http response or a Bun ReadableStream). */
export class StreamWriter {
  constructor(
    readonly write: (chunk: string | Uint8Array) => void,
    readonly end: () => void,
  ) {}
}

/**
 * The open response a streaming handler writes to. `close()` ends the response; `onClose` callbacks run once,
 * when the handler closes it or the client goes away (whichever comes first).
 */
export class StreamSink {
  private readonly callbacks: (() => void)[] = [];
  private done = false;

  constructor(private readonly writer: StreamWriter) {}

  get closed(): boolean {
    return this.done;
  }

  write(chunk: string | Uint8Array): void {
    if (!this.done) this.writer.write(chunk);
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    this.writer.end();
    this.fire();
  }

  onClose(callback: () => void): void {
    if (this.done) callback();
    else this.callbacks.push(callback);
  }

  /** Called by the server when the client disconnected. */
  disconnected(): void {
    if (this.done) return;
    this.done = true;
    this.fire();
  }

  private fire(): void {
    const all = this.callbacks.splice(0, this.callbacks.length);
    for (const cb of all) cb();
  }
}

/** A response whose body is written incrementally by `start` once the headers are sent. */
export class StreamReply extends Reply {
  constructor(
    status: number,
    headers: Record<string, string>,
    readonly start: (sink: StreamSink) => void,
    cookies: string[] = [],
  ) {
    super(status, "", headers, cookies);
  }
}

export type StreamOptions = { status?: number; contentType?: string; headers?: Record<string, string> };

/**
 * Streams a response body: `return stream(ctx, (out) => { out.write("a"); out.close(); })`.
 * The connection stays open until `out.close()` or the client disconnects (see `out.onClose`).
 */
export function stream(_ctx: Context, start: (out: StreamSink) => void, options: StreamOptions = {}): StreamReply {
  const headers: Record<string, string> = { "content-type": options.contentType ?? "text/plain; charset=utf-8", "cache-control": "no-cache" };
  const extra = options.headers ?? {};
  for (const key of Object.keys(extra)) headers[key.toLowerCase()] = extra[key]!;
  return new StreamReply(options.status ?? 200, headers, start);
}

/** One server-sent event. `data` may span lines; `id` is what a reconnecting client sends back as Last-Event-ID. */
export type SseEvent = { id?: string | number; event?: string; data: string; retry?: number };

/** Writes `text/event-stream` frames to an open stream. */
export class SseWriter {
  constructor(private readonly sink: StreamSink) {}

  get closed(): boolean {
    return this.sink.closed;
  }

  send(event: SseEvent): void {
    let frame = "";
    if (event.id !== undefined) frame += `id: ${String(event.id).replace(/[\r\n]/g, "")}\n`;
    if (event.event !== undefined) frame += `event: ${event.event.replace(/[\r\n]/g, "")}\n`;
    if (event.retry !== undefined) frame += `retry: ${Math.floor(event.retry)}\n`;
    for (const line of event.data.split(/\r\n|\r|\n/)) frame += `data: ${line}\n`;
    this.sink.write(`${frame}\n`);
  }

  /** A comment line (`: text`), e.g. a heartbeat that keeps proxies from closing the connection. */
  comment(text: string): void {
    let frame = "";
    for (const line of text.split(/\r\n|\r|\n/)) frame += `: ${line}\n`;
    this.sink.write(`${frame}\n`);
  }

  onClose(callback: () => void): void {
    this.sink.onClose(callback);
  }

  close(): void {
    this.sink.close();
  }
}

/**
 * Server-sent events: `return sse(ctx, (events) => { events.send({ id: 1, data: "hi" }); events.onClose(stop); })`.
 * Heartbeats are the app's job (`events.comment("ping")` on a timer).
 */
export function sse(ctx: Context, start: (events: SseWriter) => void, options: { headers?: Record<string, string> } = {}): StreamReply {
  const headers: Record<string, string> = { "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" };
  const extra = options.headers ?? {};
  for (const key of Object.keys(extra)) headers[key.toLowerCase()] = extra[key]!;
  return stream(ctx, (out) => start(new SseWriter(out)), { contentType: "text/event-stream; charset=utf-8", headers });
}

/** Node:http path: sends the headers, then lets the handler write; a client disconnect closes the sink. */
export function writeNodeStream(res: ServerResponse, reply: StreamReply, headers: Record<string, string | string[]>): StreamSink {
  res.writeHead(reply.status, headers);
  const sink = new StreamSink(
    new StreamWriter(
      (chunk) => {
        res.write(chunk);
      },
      () => res.end(),
    ),
  );
  // Node and scriptc report a gone client on the response; the server also wires the socket (see server.ts).
  res.on("close", () => sink.disconnected());
  reply.start(sink);
  return sink;
}

/** Bun.serve path: the stream as a `ReadableStream` body; cancelling it (client gone) closes the sink. */
export function bunStreamBody(reply: StreamReply): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const holder: { sink: StreamSink | null } = { sink: null };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const sink = new StreamSink(
        new StreamWriter(
          (chunk) => controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk),
          () => controller.close(),
        ),
      );
      holder.sink = sink;
      reply.start(sink);
    },
    cancel() {
      if (holder.sink !== null) holder.sink.disconnected();
    },
  });
}
