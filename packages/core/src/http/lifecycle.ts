import type { StreamSink } from "./stream";
import type { WsSocket } from "./websocket";

/** Work to run when the app shuts down (close a client, flush a buffer). Runs after in-flight requests finished. */
export type ShutdownHook = () => void | Promise<void>;

/**
 * What a running server has open, so the app can shut down gracefully: requests being handled, streamed responses
 * and WebSockets, plus the server's own "stop accepting connections" step. `App.shutdown()` drives it.
 */
export class Lifecycle {
  /** Requests whose response has not been fully handed to the client yet (streams count until they close). */
  inflight = 0;
  /** True once shutdown started: new responses carry `connection: close`. */
  draining = false;
  private readonly sockets = new Map<number, WsSocket>();
  private readonly streams = new Map<number, StreamSink>();
  private nextId = 1;
  private readonly idleWaiters: (() => void)[] = [];
  private readonly stoppers: (() => void)[] = [];

  begin(): void {
    this.inflight++;
  }

  end(): void {
    if (this.inflight > 0) this.inflight--;
    if (this.inflight === 0) this.wakeIdle();
  }

  /** Tracks an open WebSocket; the returned id is passed to `removeSocket` when it closes. */
  addSocket(socket: WsSocket): number {
    const id = this.nextId++;
    this.sockets.set(id, socket);
    return id;
  }

  removeSocket(id: number): void {
    this.sockets.delete(id);
    if (this.sockets.size === 0) this.wakeIdle();
  }

  /** Tracks a streamed response until its sink closes (handler closed it or the client went away). */
  addStream(sink: StreamSink): void {
    const id = this.nextId++;
    this.streams.set(id, sink);
    this.begin();
    sink.onClose(() => {
      this.streams.delete(id);
      this.end();
    });
  }

  get openSockets(): number {
    return this.sockets.size;
  }

  get openStreams(): number {
    return this.streams.size;
  }

  /** Registers how the server stops accepting connections (node:http `close`, `Bun.serve().stop`). */
  onStop(stop: () => void): void {
    this.stoppers.push(stop);
  }

  /** Stops accepting connections and asks long-lived connections to go: WebSockets get 1001, streams end. */
  stop(): void {
    this.draining = true;
    const stoppers = this.stoppers.splice(0, this.stoppers.length);
    for (const stop of stoppers) {
      try {
        stop();
      } catch {}
    }
    for (const socket of [...this.sockets.values()]) socket.close(1001, "Server shutting down");
    for (const sink of [...this.streams.values()]) sink.close();
  }

  /** Resolves true once no request is in flight and no WebSocket is open, or false after `timeout` ms. */
  idle(timeout: number): Promise<boolean> {
    if (this.isIdle()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, timeout);
      this.idleWaiters.push(() => {
        if (settled || !this.isIdle()) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private isIdle(): boolean {
    return this.inflight === 0 && this.sockets.size === 0;
  }

  private wakeIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters.splice(0, this.idleWaiters.length);
    for (const w of waiters) w();
  }
}
