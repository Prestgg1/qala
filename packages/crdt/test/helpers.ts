/**
 * Test helpers: a common API over real Yjs and @qala/crdt documents so the same random operations can run on
 * both, plus conversions between plain JS values and YValue.
 */
import * as Y from "yjs";
import { applyUpdate, DeltaOp, Doc, encodeStateAsUpdate, getDocStateVector, InsertContent, parseJson, stringifyJson, TYPE_XML_ELEMENT, TYPE_XML_TEXT, YType, YValue } from "@qala/crdt";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function toY(v: Json | undefined): YValue {
  if (v === undefined) return YValue.undefined();
  return parseJson(JSON.stringify(v));
}

export function fromY(v: YValue | null): Json | undefined {
  if (v === null || v.isUndefined()) return undefined;
  const s = stringifyJson(v);
  return s === null ? undefined : (JSON.parse(s) as Json);
}

/** Seeded PRNG (mulberry32). */
export class Rng {
  constructor(private state: number) {}
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)]!;
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
}

/** A new element or text to insert (built per implementation). */
export type Spec = { kind: "element"; name: string; attrs: [string, Json][]; children: Spec[] } | { kind: "text"; runs: [string, { [k: string]: Json } | null][] };

/** What the fuzzer needs from a document implementation. */
export interface Side {
  readonly label: string;
  readonly clientID: number;
  containers(): unknown[];
  texts(): unknown[];
  childCount(n: unknown): number;
  insertChildren(n: unknown, index: number, specs: Spec[]): void;
  deleteChildren(n: unknown, index: number, len: number): void;
  setAttr(n: unknown, key: string, value: Json): void;
  removeAttr(n: unknown, key: string): void;
  textLength(t: unknown): number;
  textString(t: unknown): string;
  insertText(t: unknown, index: number, text: string, attrs: { [k: string]: Json } | null): void;
  deleteText(t: unknown, index: number, len: number): void;
  format(t: unknown, index: number, len: number, attrs: { [k: string]: Json }): void;
  mapSet(key: string, value: Json): void;
  mapSetMap(key: string, entries: [string, Json][]): void;
  mapDelete(key: string): void;
  mapKeys(): string[];
  transact(f: () => void): void;
  applyUpdate(u: Uint8Array, origin: unknown): void;
  onUpdate(cb: (u: Uint8Array, origin: unknown) => void): void;
  stateVector(): Map<number, number>;
  /** Canonical JSON of fragment "f" (text as deltas) and map "m". */
  snapshot(): string;
  fullUpdate(): Uint8Array;
}

// ---------------------------------------------------------------- real Yjs

function yjsBuild(spec: Spec): Y.XmlElement | Y.XmlText {
  if (spec.kind === "text") {
    const t = new Y.XmlText();
    let at = 0;
    for (const [s, a] of spec.runs) {
      t.insert(at, s, a === null ? undefined : a);
      at += s.length;
    }
    return t;
  }
  const el = new Y.XmlElement(spec.name);
  for (const [k, v] of spec.attrs) el.setAttribute(k, v as never);
  if (spec.children.length > 0) el.insert(0, spec.children.map(yjsBuild));
  return el;
}

function yjsNodeJson(n: Y.XmlElement | Y.XmlText): Json {
  if (n instanceof Y.XmlText) return n.toDelta() as Json;
  return { name: n.nodeName, attrs: n.getAttributes() as Json, children: n.toArray().map((c) => yjsNodeJson(c as Y.XmlElement | Y.XmlText)) };
}

export class YjsSide implements Side {
  readonly label = "yjs";
  readonly doc: Y.Doc;
  constructor(readonly clientID: number, gc = true) {
    this.doc = new Y.Doc({ gc });
    this.doc.clientID = clientID;
  }
  private get frag(): Y.XmlFragment {
    return this.doc.getXmlFragment("f");
  }
  private get map(): Y.Map<unknown> {
    return this.doc.getMap("m");
  }
  containers(): unknown[] {
    const out: unknown[] = [this.frag];
    const walk = (n: Y.XmlFragment | Y.XmlElement): void => {
      for (const c of n.toArray()) {
        if (c instanceof Y.XmlElement) {
          out.push(c);
          walk(c);
        }
      }
    };
    walk(this.frag);
    return out;
  }
  texts(): unknown[] {
    const out: unknown[] = [];
    const walk = (n: Y.XmlFragment | Y.XmlElement): void => {
      for (const c of n.toArray()) {
        if (c instanceof Y.XmlText) out.push(c);
        else if (c instanceof Y.XmlElement) walk(c);
      }
    };
    walk(this.frag);
    return out;
  }
  childCount(n: unknown): number {
    return (n as Y.XmlFragment).length;
  }
  insertChildren(n: unknown, index: number, specs: Spec[]): void {
    (n as Y.XmlFragment).insert(index, specs.map(yjsBuild));
  }
  deleteChildren(n: unknown, index: number, len: number): void {
    (n as Y.XmlFragment).delete(index, len);
  }
  setAttr(n: unknown, key: string, value: Json): void {
    (n as Y.XmlElement).setAttribute(key, value as never);
  }
  removeAttr(n: unknown, key: string): void {
    (n as Y.XmlElement).removeAttribute(key);
  }
  textLength(t: unknown): number {
    return (t as Y.XmlText).length;
  }
  textString(t: unknown): string {
    return (t as Y.XmlText).toDelta().map((d: { insert: unknown }) => (typeof d.insert === "string" ? d.insert : " ")).join("");
  }
  insertText(t: unknown, index: number, text: string, attrs: { [k: string]: Json } | null): void {
    (t as Y.XmlText).insert(index, text, attrs === null ? undefined : attrs);
  }
  deleteText(t: unknown, index: number, len: number): void {
    (t as Y.XmlText).delete(index, len);
  }
  format(t: unknown, index: number, len: number, attrs: { [k: string]: Json }): void {
    (t as Y.XmlText).format(index, len, attrs);
  }
  mapSet(key: string, value: Json): void {
    this.map.set(key, value);
  }
  mapSetMap(key: string, entries: [string, Json][]): void {
    const m = new Y.Map<unknown>();
    for (const [k, v] of entries) m.set(k, v);
    this.map.set(key, m);
  }
  mapDelete(key: string): void {
    this.map.delete(key);
  }
  mapKeys(): string[] {
    return [...this.map.keys()];
  }
  transact(f: () => void): void {
    this.doc.transact(f);
  }
  applyUpdate(u: Uint8Array, origin: unknown): void {
    Y.applyUpdate(this.doc, u, origin);
  }
  onUpdate(cb: (u: Uint8Array, origin: unknown) => void): void {
    this.doc.on("update", (u: Uint8Array, origin: unknown) => cb(u, origin));
  }
  stateVector(): Map<number, number> {
    return Y.decodeStateVector(Y.encodeStateVector(this.doc));
  }
  snapshot(): string {
    const frag = this.frag.toArray().map((c) => yjsNodeJson(c as Y.XmlElement | Y.XmlText));
    return canonical({ f: frag, m: this.map.toJSON() });
  }
  fullUpdate(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }
}

// ---------------------------------------------------------------- @qala/crdt

function qBuild(spec: Spec): YType {
  if (spec.kind === "text") {
    const t = YType.xmlText();
    let at = 0;
    for (const [s, a] of spec.runs) {
      t.insertText(at, s, a === null ? null : toY(a));
      at += s.length;
    }
    return t;
  }
  const el = YType.xmlElement(spec.name);
  for (const [k, v] of spec.attrs) el.setAttribute(k, toY(v));
  if (spec.children.length > 0) el.insert(0, spec.children.map(qBuild));
  return el;
}

export function deltaJson(ops: DeltaOp[]): Json {
  return ops.map((op) => {
    const o: { [k: string]: Json } = { insert: op.insert.kind === 0 ? op.insert.str : (fromY(op.insert.embed) ?? null) };
    if (op.attributes !== null) o["attributes"] = fromY(op.attributes) ?? null;
    return o;
  });
}

function qNodeJson(n: YType): Json {
  if (n.kind === TYPE_XML_TEXT) return deltaJson(n.toDelta());
  return { name: n.nodeName, attrs: fromY(n.getAttributes()) ?? {}, children: n.children().map(qNodeJson) };
}

/** How often an applied update left structs or deletions pending (out-of-order delivery). */
export const stats = { applied: 0, pendingStructs: 0, pendingDs: 0, formattingCleanups: 0 };

export class QalaSide implements Side {
  readonly label = "qala";
  readonly doc: Doc;
  constructor(readonly clientID: number, gc = true) {
    this.doc = Doc.withClientId(clientID);
    this.doc.gc = gc;
  }
  private get frag(): YType {
    return this.doc.getXmlFragment("f");
  }
  private get map(): YType {
    return this.doc.getMap("m");
  }
  containers(): unknown[] {
    const out: unknown[] = [this.frag];
    const walk = (n: YType): void => {
      for (const c of n.children()) {
        if (c.kind === TYPE_XML_ELEMENT) {
          out.push(c);
          walk(c);
        }
      }
    };
    walk(this.frag);
    return out;
  }
  texts(): unknown[] {
    const out: unknown[] = [];
    const walk = (n: YType): void => {
      for (const c of n.children()) {
        if (c.kind === TYPE_XML_TEXT) out.push(c);
        else walk(c);
      }
    };
    walk(this.frag);
    return out;
  }
  childCount(n: unknown): number {
    return (n as YType).length;
  }
  insertChildren(n: unknown, index: number, specs: Spec[]): void {
    (n as YType).insert(index, specs.map(qBuild));
  }
  deleteChildren(n: unknown, index: number, len: number): void {
    (n as YType).delete(index, len);
  }
  setAttr(n: unknown, key: string, value: Json): void {
    (n as YType).setAttribute(key, toY(value));
  }
  removeAttr(n: unknown, key: string): void {
    (n as YType).removeAttribute(key);
  }
  textLength(t: unknown): number {
    return (t as YType).length;
  }
  textString(t: unknown): string {
    return (t as YType).toString();
  }
  insertText(t: unknown, index: number, text: string, attrs: { [k: string]: Json } | null): void {
    (t as YType).insertText(index, text, attrs === null ? null : toY(attrs));
  }
  deleteText(t: unknown, index: number, len: number): void {
    (t as YType).delete(index, len);
  }
  format(t: unknown, index: number, len: number, attrs: { [k: string]: Json }): void {
    (t as YType).format(index, len, toY(attrs));
  }
  mapSet(key: string, value: Json): void {
    this.map.set(key, toY(value));
  }
  mapSetMap(key: string, entries: [string, Json][]): void {
    const m = YType.map();
    for (const [k, v] of entries) m.set(k, toY(v));
    this.map.setType(key, m);
  }
  mapDelete(key: string): void {
    this.map.deleteKey(key);
  }
  mapKeys(): string[] {
    return this.map.keys();
  }
  transact(f: () => void): void {
    this.doc.transact(() => f());
  }
  applyUpdate(u: Uint8Array, origin: unknown): void {
    applyUpdate(this.doc, u, origin);
    stats.applied++;
    if (this.doc.store.pendingStructs !== null) stats.pendingStructs++;
    if (this.doc.store.pendingDs !== null) stats.pendingDs++;
  }
  onUpdate(cb: (u: Uint8Array, origin: unknown) => void): void {
    this.doc.onUpdate(cb);
  }
  stateVector(): Map<number, number> {
    return getDocStateVector(this.doc);
  }
  snapshot(): string {
    const frag = this.frag.children().map(qNodeJson);
    return canonical({ f: frag, m: fromY(this.map.toJSON()) ?? {} });
  }
  fullUpdate(): Uint8Array {
    return encodeStateAsUpdate(this.doc);
  }
}

/** JSON with object keys sorted (Yjs map key order depends on edit history, so it is not part of convergence). */
export function canonical(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x !== null && typeof x === "object") {
      const o: { [k: string]: unknown } = {};
      for (const k of Object.keys(x as object).sort()) o[k] = sort((x as { [k: string]: unknown })[k]);
      return o;
    }
    return x;
  };
  return JSON.stringify(sort(v));
}

export function svString(sv: Map<number, number>): string {
  return JSON.stringify([...sv.entries()].sort((a, b) => a[0] - b[0]));
}

export function hex(u: Uint8Array): string {
  return Buffer.from(u).toString("hex");
}

// keep InsertContent referenced for consumers of helpers
export const _unused = InsertContent;
