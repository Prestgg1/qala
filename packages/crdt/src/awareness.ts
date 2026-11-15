/**
 * The y-protocols awareness protocol: per-client JSON states (cursors, user info) with clocks.
 * The periodic timeout check is exposed as `checkOutdated(now)` instead of a built-in timer.
 */
import { Decoder, Encoder } from "./encoding";
import { deepEquals, parseJson, stringifyJson, YValue } from "./value";

export const OUTDATED_TIMEOUT = 30000;

export class MetaClientState {
  constructor(
    public clock: number,
    public lastUpdated: number,
  ) {}
}

export class AwarenessChange {
  added: number[] = [];
  updated: number[] = [];
  removed: number[] = [];
}

export type AwarenessHandler = (change: AwarenessChange, origin: unknown) => void;

export class Awareness {
  states = new Map<number, YValue>();
  meta = new Map<number, MetaClientState>();
  private changeHandlers: AwarenessHandler[] = [];
  private updateHandlers: AwarenessHandler[] = [];

  /** `clientID`: the local client (a server usually keeps its own state null). */
  constructor(public clientID: number) {
    this.setLocalState(YValue.object());
  }

  /** 'change': states really changed. */
  onChange(h: AwarenessHandler): void {
    this.changeHandlers.push(h);
  }

  /** 'update': states were updated (also when renewed with equal content). */
  onUpdate(h: AwarenessHandler): void {
    this.updateHandlers.push(h);
  }

  private emit(handlers: AwarenessHandler[], change: AwarenessChange, origin: unknown): void {
    for (const h of handlers.slice()) h(change, origin);
  }

  getLocalState(): YValue | null {
    return this.states.get(this.clientID) ?? null;
  }

  /** Sets the local state; null removes it. */
  setLocalState(state: YValue | null): void {
    const clientID = this.clientID;
    const currLocalMeta = this.meta.get(clientID);
    const clock = currLocalMeta === undefined ? 0 : currLocalMeta.clock + 1;
    const prevState = this.states.get(clientID) ?? null;
    if (state === null) this.states.delete(clientID);
    else this.states.set(clientID, state);
    this.meta.set(clientID, new MetaClientState(clock, Date.now()));
    const change = new AwarenessChange();
    const filteredUpdated: number[] = [];
    if (state === null) change.removed.push(clientID);
    else if (prevState === null) change.added.push(clientID);
    else {
      change.updated.push(clientID);
      if (!deepEquals(prevState, state)) filteredUpdated.push(clientID);
    }
    if (change.added.length > 0 || filteredUpdated.length > 0 || change.removed.length > 0) {
      const c = new AwarenessChange();
      c.added = change.added;
      c.updated = filteredUpdated;
      c.removed = change.removed;
      this.emit(this.changeHandlers, c, "local");
    }
    this.emit(this.updateHandlers, change, "local");
  }

  /** Removes states of clients that have not been updated for 30 s (call it periodically, e.g. every 3 s). */
  checkOutdated(now: number): void {
    const local = this.getLocalState();
    const localMeta = this.meta.get(this.clientID);
    if (local !== null && localMeta !== undefined && OUTDATED_TIMEOUT / 2 <= now - localMeta.lastUpdated) this.setLocalState(local);
    const remove: number[] = [];
    for (const [clientID, meta] of this.meta) {
      if (clientID !== this.clientID && OUTDATED_TIMEOUT <= now - meta.lastUpdated && this.states.has(clientID)) remove.push(clientID);
    }
    if (remove.length > 0) removeAwarenessStates(this, remove, "timeout");
  }

  /** @internal */
  emitBoth(change: AwarenessChange, origin: unknown): void {
    this.emit(this.changeHandlers, change, origin);
    this.emit(this.updateHandlers, change, origin);
  }

  /** @internal */
  emitChange(change: AwarenessChange, origin: unknown): void {
    this.emit(this.changeHandlers, change, origin);
  }

  /** @internal */
  emitUpdate(change: AwarenessChange, origin: unknown): void {
    this.emit(this.updateHandlers, change, origin);
  }
}

export function removeAwarenessStates(awareness: Awareness, clients: number[], origin: unknown): void {
  const removed: number[] = [];
  for (const clientID of clients) {
    if (awareness.states.has(clientID)) {
      awareness.states.delete(clientID);
      if (clientID === awareness.clientID) {
        const cur = awareness.meta.get(clientID)!;
        awareness.meta.set(clientID, new MetaClientState(cur.clock + 1, Date.now()));
      }
      removed.push(clientID);
    }
  }
  if (removed.length > 0) {
    const c = new AwarenessChange();
    c.removed = removed;
    awareness.emitBoth(c, origin);
  }
}

export function encodeAwarenessUpdate(awareness: Awareness, clients: number[]): Uint8Array {
  const encoder = new Encoder();
  encoder.writeVarUint(clients.length);
  for (const clientID of clients) {
    const state = awareness.states.get(clientID) ?? null;
    const meta = awareness.meta.get(clientID);
    encoder.writeVarUint(clientID);
    encoder.writeVarUint(meta === undefined ? 0 : meta.clock);
    encoder.writeVarString(state === null ? "null" : (stringifyJson(state) ?? "null"));
  }
  return encoder.toUint8Array();
}

export function applyAwarenessUpdate(awareness: Awareness, update: Uint8Array, origin: unknown): void {
  const decoder = new Decoder(update);
  const timestamp = Date.now();
  const added: number[] = [];
  const updated: number[] = [];
  const filteredUpdated: number[] = [];
  const removed: number[] = [];
  const len = decoder.readVarUint();
  for (let i = 0; i < len; i++) {
    const clientID = decoder.readVarUint();
    let clock = decoder.readVarUint();
    const parsed = parseJson(decoder.readVarString());
    const state: YValue | null = parsed.isNull() ? null : parsed;
    const clientMeta = awareness.meta.get(clientID);
    const prevState = awareness.states.get(clientID) ?? null;
    const currClock = clientMeta === undefined ? 0 : clientMeta.clock;
    if (currClock < clock || (currClock === clock && state === null && awareness.states.has(clientID))) {
      if (state === null) {
        if (clientID === awareness.clientID && awareness.getLocalState() !== null) clock++;
        else awareness.states.delete(clientID);
      } else awareness.states.set(clientID, state);
      awareness.meta.set(clientID, new MetaClientState(clock, timestamp));
      if (clientMeta === undefined && state !== null) added.push(clientID);
      else if (clientMeta !== undefined && state === null) removed.push(clientID);
      else if (state !== null) {
        if (prevState === null || !deepEquals(state, prevState)) filteredUpdated.push(clientID);
        updated.push(clientID);
      }
    }
  }
  if (added.length > 0 || filteredUpdated.length > 0 || removed.length > 0) {
    const c = new AwarenessChange();
    c.added = added;
    c.updated = filteredUpdated;
    c.removed = removed;
    awareness.emitChange(c, origin);
  }
  if (added.length > 0 || updated.length > 0 || removed.length > 0) {
    const c = new AwarenessChange();
    c.added = added;
    c.updated = updated;
    c.removed = removed;
    awareness.emitUpdate(c, origin);
  }
}
