import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import {
  applyUpdate,
  encodeStateAsUpdate,
  getDocStateVector,
  parseJson,
  applyAwarenessUpdate,
  Awareness,
  Decoder,
  Doc,
  Encoder,
  encodeAwarenessUpdate,
  PmSchema,
  pmJsonToYDoc,
  readSyncMessage,
  removeAwarenessStates,
  writeSyncStep1,
  writeUpdate,
  yDocToPmJson,
} from "@qala/crdt";
import { canonical, hex, Rng } from "./helpers";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/** A y-websocket style room on @qala/crdt (what a collab server runs). */
class Room {
  readonly doc = Doc.withClientId(1);
  readonly awareness = new Awareness(1);
  readonly peers: Client[] = [];
  constructor() {
    this.awareness.setLocalState(null);
    this.doc.onUpdate((update, origin) => {
      const e = new Encoder();
      e.writeVarUint(MESSAGE_SYNC);
      writeUpdate(e, update);
      for (const p of this.peers) if (p !== origin) p.inbox.push(e.toUint8Array());
    });
    this.awareness.onUpdate((change) => {
      const e = new Encoder();
      e.writeVarUint(MESSAGE_AWARENESS);
      e.writeVarUint8Array(encodeAwarenessUpdate(this.awareness, [...change.added, ...change.updated, ...change.removed]));
      for (const p of this.peers) p.inbox.push(e.toUint8Array());
    });
  }
  join(c: Client): void {
    this.peers.push(c);
    const e = new Encoder();
    e.writeVarUint(MESSAGE_SYNC);
    writeSyncStep1(e, this.doc);
    c.inbox.push(e.toUint8Array());
  }
  receive(from: Client, data: Uint8Array): void {
    const d = new Decoder(data);
    const kind = d.readVarUint();
    if (kind === MESSAGE_SYNC) {
      const reply = new Encoder();
      reply.writeVarUint(MESSAGE_SYNC);
      readSyncMessage(d, reply, this.doc, from);
      if (reply.pos > 1) from.inbox.push(reply.toUint8Array());
    } else if (kind === MESSAGE_AWARENESS) {
      applyAwarenessUpdate(this.awareness, d.readVarUint8Array(), from);
    }
  }
}

/** A real Yjs client speaking y-protocols. */
class Client {
  readonly doc = new Y.Doc();
  readonly awareness: awarenessProtocol.Awareness;
  readonly inbox: Uint8Array[] = [];
  readonly outbox: Uint8Array[] = [];
  constructor(readonly id: number) {
    this.doc.clientID = id;
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    clearInterval((this.awareness as unknown as { _checkInterval: ReturnType<typeof setInterval> })._checkInterval);
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "server") return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MESSAGE_SYNC);
      syncProtocol.writeUpdate(e, update);
      this.outbox.push(encoding.toUint8Array(e));
    });
    this.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === "server") return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]));
      this.outbox.push(encoding.toUint8Array(e));
    });
  }
  /** y-websocket's provider: step 1 on connect. */
  connect(): void {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(e, this.doc);
    this.outbox.push(encoding.toUint8Array(e));
  }
  process(): void {
    while (this.inbox.length > 0) {
      const data = this.inbox.shift()!;
      const d = decoding.createDecoder(data);
      const kind = decoding.readVarUint(d);
      if (kind === MESSAGE_SYNC) {
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(d, reply, this.doc, "server");
        if (encoding.length(reply) > 1) this.outbox.push(encoding.toUint8Array(reply));
      } else awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(d), "server");
    }
  }
}

function pump(room: Room, clients: Client[]): void {
  for (let round = 0; round < 50; round++) {
    let moved = false;
    for (const c of clients) {
      while (c.outbox.length > 0) {
        room.receive(c, c.outbox.shift()!);
        moved = true;
      }
      if (c.inbox.length > 0) {
        c.process();
        moved = true;
      }
    }
    if (!moved) return;
  }
  throw new Error("no quiescence");
}

describe("sync protocol with real y-protocols clients", () => {
  test("clients editing concurrently converge through our server", () => {
    const room = new Room();
    const rng = new Rng(7);
    const clients = [new Client(101), new Client(202), new Client(303)];
    // the first client brings existing content before connecting
    const f0 = clients[0]!.doc.getXmlFragment("default");
    const p = new Y.XmlElement("paragraph");
    const t0 = new Y.XmlText();
    t0.insert(0, "hello world");
    p.insert(0, [t0]);
    f0.insert(0, [p]);
    for (const c of clients) {
      room.join(c);
      c.connect();
    }
    pump(room, clients);
    for (let i = 0; i < 300; i++) {
      const c = rng.pick(clients);
      const frag = c.doc.getXmlFragment("default");
      const para = frag.get(0) as Y.XmlElement;
      const text = para.get(0) as Y.XmlText;
      const r = rng.int(5);
      if (r === 0) text.insert(rng.int(text.length + 1), rng.pick(["a", "bc", " ", "ö"]), rng.bool() ? { bold: {} } : undefined);
      else if (r === 1 && text.length > 0) text.delete(rng.int(text.length), 1);
      else if (r === 2 && text.length > 1) text.format(rng.int(text.length - 1), 1, { italic: rng.bool() ? true : null });
      else if (r === 3) frag.insert(frag.length, [new Y.XmlElement("paragraph")]);
      else c.awareness.setLocalStateField("cursor", { at: i });
      if (rng.bool(0.3)) pump(room, clients);
    }
    pump(room, clients);
    const serverJson = canonical(JSON.parse(yDocToPmJson(room.doc, "default")));
    const serverSv = JSON.stringify([...getDocStateVector(room.doc).entries()].sort((a, b) => a[0] - b[0]));
    for (const c of clients) {
      // same state vector as the server
      expect(JSON.stringify([...Y.decodeStateVector(Y.encodeStateVector(c.doc)).entries()].sort((a, b) => a[0] - b[0]))).toBe(serverSv);
      // the client's full state, loaded into our implementation, is the server's document
      const fresh = new Doc();
      applyUpdate(fresh, Y.encodeStateAsUpdate(c.doc));
      expect(canonical(JSON.parse(yDocToPmJson(fresh, "default")))).toBe(serverJson);
      // and the server's full state, loaded into Yjs, is the client's document
      const yfresh = new Y.Doc();
      Y.applyUpdate(yfresh, encodeStateAsUpdate(room.doc));
      expect(yfresh.getXmlFragment("default").toString()).toBe(c.doc.getXmlFragment("default").toString());
    }
    // awareness: every client sees every other client's state through the server
    for (const c of clients) for (const other of clients) if (other !== c) expect(c.awareness.getStates().get(other.id)).toEqual(other.awareness.getLocalState() as never);
  });

  test("a late joiner gets everything with one step-1/step-2 round trip", () => {
    const room = new Room();
    const a = new Client(11);
    room.join(a);
    a.connect();
    pump(room, [a]);
    const text = new Y.XmlText();
    text.insert(0, "abc");
    const el = new Y.XmlElement("paragraph");
    el.insert(0, [text]);
    a.doc.getXmlFragment("default").insert(0, [el]);
    pump(room, [a]);
    const late = new Client(22);
    room.join(late);
    late.connect();
    pump(room, [a, late]);
    expect(late.doc.getXmlFragment("default").toString()).toBe(a.doc.getXmlFragment("default").toString());
  });
});

describe("awareness compatibility with y-protocols", () => {
  test("y-protocols updates decode and re-encode byte-identically", () => {
    const yd = new Y.Doc();
    yd.clientID = 5;
    const theirs = new awarenessProtocol.Awareness(yd);
    clearInterval((theirs as unknown as { _checkInterval: ReturnType<typeof setInterval> })._checkInterval);
    theirs.setLocalState({ user: { name: "Ali Vəli", color: "#f0a" }, cursor: { anchor: 3, head: [1, 2.5] }, "2": true, "1": null, q: "\"\u0001\ud800" });
    const ours = new Awareness(9);
    ours.setLocalState(null);
    const u1 = awarenessProtocol.encodeAwarenessUpdate(theirs, [5]);
    applyAwarenessUpdate(ours, u1, "x");
    expect(hex(encodeAwarenessUpdate(ours, [5]))).toBe(hex(u1));
    theirs.setLocalState(null);
    applyAwarenessUpdate(ours, awarenessProtocol.encodeAwarenessUpdate(theirs, [5]), "x");
    expect(ours.states.has(5)).toBe(false);
  });

  test("our states reach y-protocols byte-identically, removals and change events included", () => {
    const ours = new Awareness(31);
    ours.setLocalState(parseJson('{"user":{"name":"Ayşə"},"cursor":null,"n":[1,2.5,-0.1]}'));
    const yd = new Y.Doc();
    yd.clientID = 32;
    const theirs = new awarenessProtocol.Awareness(yd);
    clearInterval((theirs as unknown as { _checkInterval: ReturnType<typeof setInterval> })._checkInterval);
    const u = encodeAwarenessUpdate(ours, [31]);
    const events: string[] = [];
    theirs.on("change", ({ added }: { added: number[] }) => events.push("added " + added.join()));
    awarenessProtocol.applyAwarenessUpdate(theirs, u, null);
    expect(events).toEqual(["added 31"]);
    expect(hex(awarenessProtocol.encodeAwarenessUpdate(theirs, [31]))).toBe(hex(u));
    removeAwarenessStates(ours, [31], null);
    awarenessProtocol.applyAwarenessUpdate(theirs, encodeAwarenessUpdate(ours, [31]), null);
    expect(theirs.getStates().has(31)).toBe(false);
  });
});

describe("ProseMirror mapping", () => {
  const schema = new PmSchema(
    ["paragraph", "heading", "bulletList", "listItem", "hardBreak"],
    ["{}", '{"level":1}', "{}", "{}", "{}"],
    ["link", "bold", "italic"],
    ['{"href":null,"target":"_blank"}', "{}", "{}"],
  );
  const json = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title ", marks: [{ type: "italic" }, { type: "bold" }] }, { type: "text", text: "x" }] },
      { type: "paragraph", content: [{ type: "text", text: "see " }, { type: "text", text: "site", marks: [{ type: "link", attrs: { href: "https://a.az" } }] }, { type: "hardBreak" }, { type: "text", text: "😀 ödəniş" }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph" }] }] },
    ],
  };

  /** The same construction with real Yjs (y-prosemirror createTypeFromElementNode / createTypeFromTextNodes). */
  function viaYjs(clientID: number): Y.Doc {
    const doc = new Y.Doc();
    doc.clientID = clientID;
    const text = (runs: [string, Record<string, unknown>][]) => {
      const t = new Y.XmlText();
      t.applyDelta(runs.map(([insert, attributes]) => ({ insert, attributes })));
      return t;
    };
    const el = (name: string, attrs: Record<string, unknown>, children: (Y.XmlElement | Y.XmlText)[]) => {
      const e = new Y.XmlElement(name);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v as never);
      e.insert(0, children);
      return e;
    };
    const content = [
      el("heading", { level: 2 }, [text([["Title ", { bold: {}, italic: {} }], ["x", {}]])]),
      el("paragraph", {}, [text([["see ", {}], ["site", { link: { href: "https://a.az", target: "_blank" } }]]), el("hardBreak", {}, []), text([["😀 ödəniş", {}]])]),
      el("bulletList", {}, [el("listItem", {}, [el("paragraph", {}, [])])]),
    ];
    const frag = doc.getXmlFragment("default");
    doc.transact(() => frag.insert(0, content));
    return doc;
  }

  test("pmJsonToYDoc produces the same update bytes as the y-prosemirror construction", () => {
    const mine = pmJsonToYDoc(schema, JSON.stringify(json), "default", 4321);
    const theirs = viaYjs(4321);
    expect(hex(encodeStateAsUpdate(mine))).toBe(hex(Y.encodeStateAsUpdate(theirs)));
  });

  test("yDocToPmJson writes the JSON y-prosemirror writes", () => {
    const mine = pmJsonToYDoc(schema, JSON.stringify(json), "default", 1);
    expect(JSON.parse(yDocToPmJson(mine, "default"))).toEqual({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title ", marks: [{ type: "bold", attrs: {} }, { type: "italic", attrs: {} }] }, { type: "text", text: "x" }] },
        { type: "paragraph", content: [{ type: "text", text: "see " }, { type: "text", text: "site", marks: [{ type: "link", attrs: { href: "https://a.az", target: "_blank" } }] }, { type: "hardBreak" }, { type: "text", text: "😀 ödəniş" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph" }] }] },
      ],
    });
  });

  test("invalid documents are rejected", () => {
    expect(() => pmJsonToYDoc(schema, '{"type":"doc","content":[{"type":"nope"}]}', "default", 1)).toThrow();
    expect(() => pmJsonToYDoc(schema, '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":""}]}]}', "default", 1)).toThrow();
    expect(() => pmJsonToYDoc(schema, '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x","marks":[{"type":"zz"}]}]}]}', "default", 1)).toThrow();
  });
});
