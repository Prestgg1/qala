import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { Decoder, Encoder, YValue } from "@qala/crdt";
import { fromY, hex, QalaSide, type Side, svString, toY, YjsSide } from "./helpers";

describe("lib0 encoding", () => {
  const values: unknown[] = [
    0, 1, -1, 63, 64, -64, 127, 128, 2147483647, -2147483647, 2147483648, 1.5, 0.1, -0.5, 1e21, -0, 3.4028234663852886e38,
    "", "a", "ä€😀", "lone \ud800 surrogate", true, false, null, undefined,
    [1, "x", [null]], { a: 1, b: { c: [true] }, "2": "x", "1": "y" }, new Uint8Array([1, 2, 255]),
  ];
  test("writeAny / readAny are byte-identical to lib0", () => {
    for (const v of values) {
      const e = encoding.createEncoder();
      encoding.writeAny(e, v as never);
      const theirs = encoding.toUint8Array(e);
      const yv = v instanceof Uint8Array ? YValue.bytes(v) : v === undefined ? YValue.undefined() : typeof v === "number" ? YValue.number(v) : toY(v as never);
      const ours = new Encoder();
      ours.writeAny(yv);
      expect(hex(ours.toUint8Array())).toBe(hex(theirs));
      const back = new Decoder(theirs).readAny();
      const theirsBack = decoding.readAny(decoding.createDecoder(theirs));
      if (v instanceof Uint8Array) expect([...back.bytes]).toEqual([...v]);
      else if (typeof v === "number") expect(Object.is(back.n, theirsBack)).toBe(true);
      else expect(fromY(back)).toEqual(theirsBack as never);
    }
  });
  test("varUint / varInt / varString", () => {
    for (const n of [0, 1, 127, 128, 16383, 16384, 2 ** 31, 2 ** 32 + 5, Number.MAX_SAFE_INTEGER]) {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, n);
      const o = new Encoder();
      o.writeVarUint(n);
      expect(hex(o.toUint8Array())).toBe(hex(encoding.toUint8Array(e)));
      expect(new Decoder(o.toUint8Array()).readVarUint()).toBe(n);
    }
    for (const n of [0, -0, 5, -5, 63, -64, 1000000, -2147483647]) {
      const e = encoding.createEncoder();
      encoding.writeVarInt(e, n);
      const o = new Encoder();
      o.writeVarInt(n);
      expect(hex(o.toUint8Array())).toBe(hex(encoding.toUint8Array(e)));
    }
    for (const s of ["", "hello", "Azərbaycan ödəniş", "😀\ud83d", "\udc00x"]) {
      const e = encoding.createEncoder();
      encoding.writeVarString(e, s);
      const o = new Encoder();
      o.writeVarString(s);
      expect(hex(o.toUint8Array())).toBe(hex(encoding.toUint8Array(e)));
      const theirs = decoding.readVarString(decoding.createDecoder(encoding.toUint8Array(e)));
      expect(new Decoder(o.toUint8Array()).readVarString()).toBe(theirs);
    }
  });
  test("invalid UTF-8 decodes like TextDecoder", () => {
    const samples = [[0xff], [0xc3], [0xe2, 0x82], [0xf0, 0x9f, 0x98], [0xed, 0xa0, 0x80], [0x61, 0x80, 0x62], [0xf4, 0x90, 0x80, 0x80], [0xe0, 0x80, 0x80]];
    for (const s of samples) {
      const bytes = new Uint8Array(s);
      const e = new Encoder();
      e.writeVarUint8Array(bytes);
      expect(new Decoder(e.toUint8Array()).readVarString()).toBe(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes));
    }
  });
});

function both(clientID: number): [Side, Side] {
  return [new YjsSide(clientID), new QalaSide(clientID)];
}

describe("same operations produce the same bytes as Yjs", () => {
  test("xml fragment with elements, attributes and formatted text", () => {
    for (const side of both(7)) {
      side.transact(() => {
        side.insertChildren(side.containers()[0], 0, [
          { kind: "element", name: "heading", attrs: [["level", 2]], children: [{ kind: "text", runs: [["Hello ", null], ["world", { bold: {} }]] }] },
          { kind: "element", name: "paragraph", attrs: [], children: [{ kind: "text", runs: [["link", { link: { href: "https://x.az", target: "_blank" } }]] }] },
        ]);
      });
    }
    const [y, q] = both(7);
    for (const s of [y, q]) {
      const root = s.containers()[0];
      s.insertChildren(root, 0, [{ kind: "element", name: "p", attrs: [["a", "1"]], children: [{ kind: "text", runs: [["abc", null]] }] }]);
      const t = s.texts()[0];
      s.insertText(t, 1, "XY", { italic: true });
      s.format(t, 0, 4, { bold: {} });
      s.deleteText(t, 2, 2);
      s.setAttr(s.containers()[1], "b", { x: [1, 2] });
      s.removeAttr(s.containers()[1], "a");
      s.mapSet("k", { n: 1.5, s: "x" });
      s.mapSetMap("nested", [["a", 1], ["b", null]]);
      s.mapDelete("k");
    }
    expect(q.snapshot()).toBe(y.snapshot());
    expect(hex(q.fullUpdate())).toBe(hex(y.fullUpdate()));
    expect(svString(q.stateVector())).toBe(svString(y.stateVector()));
  });

  test("emitted transaction updates are identical", () => {
    const [y, q] = both(11);
    const yu: string[] = [];
    const qu: string[] = [];
    y.onUpdate((u) => yu.push(hex(u)));
    q.onUpdate((u) => qu.push(hex(u)));
    for (const s of [y, q]) {
      const root = s.containers()[0];
      s.insertChildren(root, 0, [{ kind: "element", name: "p", attrs: [], children: [{ kind: "text", runs: [["hello world", null]] }] }]);
      const t = s.texts()[0];
      s.format(t, 2, 5, { bold: {} });
      s.insertText(t, 3, "!!", null);
      s.deleteText(t, 0, 4);
      s.deleteChildren(root, 0, 1);
      s.mapSet("x", [1, "two", null, true]);
    }
    expect(qu).toEqual(yu);
  });

  test("updates from Yjs apply to our doc and back", () => {
    const y = new YjsSide(1);
    const q = new QalaSide(2);
    y.onUpdate((u) => q.applyUpdate(u, "y"));
    q.onUpdate((u, origin) => {
      if (origin !== "y") y.applyUpdate(u, "q");
    });
    const yr = y.containers()[0];
    y.insertChildren(yr, 0, [{ kind: "element", name: "p", attrs: [], children: [{ kind: "text", runs: [["abc", null]] }] }]);
    const qt = q.texts()[0];
    q.insertText(qt, 3, "def", { bold: {} });
    y.format(y.texts()[0], 1, 4, { italic: true });
    q.deleteText(q.texts()[0], 0, 1);
    expect(q.snapshot()).toBe(y.snapshot());
    expect(svString(q.stateVector())).toBe(svString(y.stateVector()));
  });

  test("Y.Doc state from Yjs decodes and re-encodes identically", () => {
    const d = new Y.Doc();
    d.clientID = 99;
    const f = d.getXmlFragment("f");
    const p = new Y.XmlElement("p");
    const t = new Y.XmlText();
    t.insert(0, "hello 😀 world", { bold: {} });
    p.insert(0, [t]);
    f.insert(0, [p]);
    t.delete(2, 3);
    d.getMap("m").set("a", { b: [1, 2.5, "x"] });
    const update = Y.encodeStateAsUpdate(d);
    const q = new QalaSide(5);
    q.applyUpdate(update, null);
    expect(hex(q.fullUpdate())).toBe(hex(update));
  });
});
