/**
 * Differential fuzzing: 3 documents (a mix of real Yjs and @qala/crdt) make random concurrent edits, exchange
 * updates in random order (so some arrive before their dependencies and wait as pending), then must converge.
 */
import { type Json, QalaSide, Rng, type Side, type Spec, svString, YjsSide } from "./helpers";

const NAMES = ["paragraph", "heading", "listItem", "taskItem"];
const KEYS = ["level", "checked", "align", "data"];
const TEXTS = ["a", "bc", "def", "😀", "x😀y", "Azərbaycan", "\n", "hello world"];
const ATTRS: ({ [k: string]: Json } | null)[] = [null, {}, { bold: {} }, { italic: true }, { link: { href: "https://a.az", target: "_blank" } }, { bold: {}, italic: true }];
const FORMATS: { [k: string]: Json }[] = [{ bold: {} }, { bold: null }, { italic: true }, { italic: null }, { link: { href: "https://b.az" } }, { link: null, bold: {} }];
const VALUES: Json[] = [1, -2.5, "s", true, null, [1, "a"], { x: 1, y: [null] }, 2147483648];

function randomJson(rng: Rng): Json {
  return rng.pick(VALUES);
}

function randomSpec(rng: Rng, depth: number): Spec {
  if (depth > 1 || rng.bool(0.4)) {
    const runs: [string, { [k: string]: Json } | null][] = [];
    const n = 1 + rng.int(2);
    for (let i = 0; i < n; i++) runs.push([rng.pick(TEXTS), rng.pick(ATTRS)]);
    return { kind: "text", runs };
  }
  const attrs: [string, Json][] = [];
  if (rng.bool()) attrs.push([rng.pick(KEYS), randomJson(rng)]);
  const children: Spec[] = [];
  const n = rng.int(3);
  for (let i = 0; i < n; i++) children.push(randomSpec(rng, depth + 1));
  return { kind: "element", name: rng.pick(NAMES), attrs, children };
}

/** Moves an index off the middle of a surrogate pair (Yjs itself diverges when a split falls there). */
function snap(text: string, i: number): number {
  if (i > 0 && i < text.length) {
    const c = text.charCodeAt(i - 1);
    if (c >= 0xd800 && c <= 0xdbff) return i - 1;
  }
  return i;
}

function randomOp(side: Side, rng: Rng): void {
  const r = rng.int(100);
  if (r < 22) {
    const containers = side.containers();
    const c = rng.pick(containers);
    const specs: Spec[] = [];
    const n = 1 + rng.int(2);
    for (let i = 0; i < n; i++) specs.push(randomSpec(rng, 0));
    side.insertChildren(c, rng.int(side.childCount(c) + 1), specs);
  } else if (r < 32) {
    const c = rng.pick(side.containers());
    const count = side.childCount(c);
    if (count === 0) return;
    const at = rng.int(count);
    side.deleteChildren(c, at, 1 + rng.int(Math.min(2, count - at)));
  } else if (r < 42) {
    const containers = side.containers().slice(1);
    if (containers.length === 0) return;
    const c = rng.pick(containers);
    if (rng.bool(0.7)) side.setAttr(c, rng.pick(KEYS), randomJson(rng));
    else side.removeAttr(c, rng.pick(KEYS));
  } else if (r < 62) {
    const texts = side.texts();
    if (texts.length === 0) return;
    const t = rng.pick(texts);
    const str = side.textString(t);
    side.insertText(t, snap(str, rng.int(side.textLength(t) + 1)), rng.pick(TEXTS), rng.pick(ATTRS));
  } else if (r < 72) {
    const texts = side.texts();
    if (texts.length === 0) return;
    const t = rng.pick(texts);
    const len = side.textLength(t);
    if (len === 0) return;
    const str = side.textString(t);
    const at = snap(str, rng.int(len));
    const end = snap(str, Math.min(len, at + 1 + rng.int(4)));
    if (end > at) side.deleteText(t, at, end - at);
  } else if (r < 85) {
    const texts = side.texts();
    if (texts.length === 0) return;
    const t = rng.pick(texts);
    const len = side.textLength(t);
    if (len === 0) return;
    const str = side.textString(t);
    const at = snap(str, rng.int(len));
    const end = snap(str, at + 1 + rng.int(len - at));
    if (end > at) side.format(t, at, end - at, rng.pick(FORMATS));
  } else if (r < 93) {
    const key = "k" + rng.int(5);
    if (rng.bool(0.25)) side.mapSetMap(key, [["a", randomJson(rng)], ["b", randomJson(rng)]]);
    else side.mapSet(key, randomJson(rng));
  } else if (r < 97) {
    const keys = side.mapKeys();
    if (keys.length > 0) side.mapDelete(rng.pick(keys));
  } else {
    side.transact(() => {
      randomOp(side, rng);
      randomOp(side, rng);
    });
  }
}

class Message {
  constructor(
    readonly from: number,
    readonly bytes: Uint8Array,
  ) {}
}

export class ScenarioResult {
  ok = true;
  detail = "";
  updates = 0;
  pendingSeen = 0;
}

/** One scenario; `kinds` picks the implementation per document ("q" ours, "y" Yjs). */
export function runScenario(seed: number, steps: number, kinds: string): ScenarioResult {
  const rng = new Rng(seed);
  const sides: Side[] = [];
  const used = new Set<number>();
  for (let i = 0; i < kinds.length; i++) {
    let id = 1 + rng.int(1000000);
    while (used.has(id)) id++;
    used.add(id);
    const gc = rng.bool(0.85);
    sides.push(kinds[i] === "y" ? new YjsSide(id, gc) : new QalaSide(id, gc));
  }
  const inbox: Message[][] = sides.map(() => []);
  const result = new ScenarioResult();
  sides.forEach((side, i) => {
    side.onUpdate((u) => {
      result.updates++;
      for (let k = 0; k < sides.length; k++) if (k !== i) inbox[k]!.push(new Message(i, u));
    });
  });
  const deliver = (k: number, index: number): void => {
    const msg = inbox[k]!.splice(index, 1)[0]!;
    sides[k]!.applyUpdate(msg.bytes, "remote");
  };
  for (let s = 0; s < steps; s++) {
    if (rng.bool(0.65)) randomOp(rng.pick(sides), rng);
    else {
      const k = rng.int(sides.length);
      const n = rng.int(3);
      for (let j = 0; j < n && inbox[k]!.length > 0; j++) deliver(k, rng.int(inbox[k]!.length));
    }
  }
  let guard = 0;
  while (inbox.some((q) => q.length > 0)) {
    for (let k = 0; k < sides.length; k++) while (inbox[k]!.length > 0) deliver(k, rng.int(inbox[k]!.length));
    if (++guard > 100) {
      result.ok = false;
      result.detail = "no quiescence";
      return result;
    }
  }
  const sv0 = svString(sides[0]!.stateVector());
  const snap0 = sides[0]!.snapshot();
  for (let i = 1; i < sides.length; i++) {
    const sv = svString(sides[i]!.stateVector());
    const snap = sides[i]!.snapshot();
    if (sv !== sv0 || snap !== snap0) {
      result.ok = false;
      let at = 0;
      while (at < snap.length && snap[at] === snap0[at]) at++;
      result.detail = `doc ${i} (${sides[i]!.label}) differs from doc 0 (${sides[0]!.label}): sv equal ${sv === sv0}\n ...${snap0.slice(Math.max(0, at - 200), at + 200)}\n vs ...${snap.slice(Math.max(0, at - 200), at + 200)}`;
      return result;
    }
  }
  // every document's full state, loaded into a fresh doc of each implementation, gives the same content
  for (let i = 0; i < sides.length; i++) {
    const full = sides[i]!.fullUpdate();
    for (const fresh of [new YjsSide(4242), new QalaSide(4242)]) {
      fresh.applyUpdate(full, null);
      if (fresh.snapshot() !== snap0) {
        result.ok = false;
        result.detail = `full state of doc ${i} (${sides[i]!.label}) loaded into ${fresh.label} differs:\n ${snap0}\n vs ${fresh.snapshot()}`;
        return result;
      }
    }
  }
  return result;
}
