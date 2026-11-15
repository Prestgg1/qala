/**
 * ProseMirror JSON <-> Y.XmlFragment, equivalent to y-prosemirror's prosemirrorJSONToYDoc /
 * yXmlFragmentToProsemirrorJSON (as shipped in @tiptap/y-tiptap), without prosemirror or tiptap.
 *
 * The schema is data (`PmSchema`): node and mark names with their attribute defaults; marks in schema rank
 * order. Only non-overlapping marks (marks that exclude themselves) are supported.
 */
import { DeltaOp, Doc, TYPE_XML_ELEMENT, TYPE_XML_TEXT, YType } from "./doc";
import { parseJson, stringifyJson, T_ARRAY, T_OBJECT, T_STRING, YValue } from "./value";

class AttrSpec {
  constructor(
    readonly keys: string[],
    readonly defaults: YValue[],
  ) {}
}

function specOf(defaultsJson: string): AttrSpec {
  const o = parseJson(defaultsJson);
  if (o.tag !== T_OBJECT) throw new Error("Attribute defaults must be a JSON object");
  return new AttrSpec(o.keys, o.items);
}

/** The parts of a ProseMirror schema the mapping needs. */
export class PmSchema {
  private readonly nodeSpecs: AttrSpec[] = [];
  private readonly markSpecs: AttrSpec[] = [];

  /**
   * @param nodeDefaults per node: a JSON object of its attributes and defaults in spec order ("{}" if none)
   * @param markNames marks in schema rank order (a text node's marks are sorted by it)
   */
  constructor(
    readonly nodeNames: string[],
    nodeDefaults: string[],
    readonly markNames: string[],
    markDefaults: string[],
  ) {
    for (const d of nodeDefaults) this.nodeSpecs.push(specOf(d));
    for (const d of markDefaults) this.markSpecs.push(specOf(d));
  }

  nodeSpec(name: string): AttrSpec | null {
    for (let i = 0; i < this.nodeNames.length; i++) if (this.nodeNames[i] === name) return this.nodeSpecs[i]!;
    return null;
  }

  markRank(name: string): number {
    for (let i = 0; i < this.markNames.length; i++) if (this.markNames[i] === name) return i;
    return -1;
  }

  markSpec(rank: number): AttrSpec {
    return this.markSpecs[rank]!;
  }
}

class TextRun {
  constructor(
    public text: string,
    /** Marks as y-prosemirror stores them: { markName: attrs } in rank order. */
    readonly marks: YValue,
  ) {}
}

function readMarks(schema: PmSchema, json: YValue): YValue {
  const out = YValue.object();
  const marks = json.get("marks");
  if (marks === null || marks.isNull() || marks.isUndefined()) return out;
  if (marks.tag !== T_ARRAY) throw new Error("Invalid mark data");
  const ranks: number[] = [];
  const attrs: YValue[] = [];
  for (const m of marks.items) {
    const t = m.get("type");
    const rank = t !== null && t.tag === T_STRING ? schema.markRank(t.s) : -1;
    if (rank < 0) throw new Error("There is no mark type in this schema");
    const sp = schema.markSpec(rank);
    const given = m.get("attrs");
    const a = YValue.object();
    for (let k = 0; k < sp.keys.length; k++) {
      const g = given === null ? null : given.get(sp.keys[k]!);
      a.set(sp.keys[k]!, g !== null && !g.isUndefined() ? g : sp.defaults[k]!);
    }
    let at = ranks.length;
    while (at > 0 && ranks[at - 1]! > rank) at--;
    ranks.splice(at, 0, rank);
    attrs.splice(at, 0, a);
  }
  for (let i = 0; i < ranks.length; i++) out.set(schema.markNames[ranks[i]!]!, attrs[i]!);
  return out;
}

function sameMarks(a: YValue, b: YValue): boolean {
  return stringifyJson(a) === stringifyJson(b);
}

function textType(runs: TextRun[]): YType {
  const type = YType.xmlText();
  const delta: DeltaOp[] = [];
  for (const r of runs) delta.push(DeltaOp.insertString(r.text, r.marks));
  type.applyDelta(delta);
  return type;
}

function readChildren(schema: PmSchema, content: YValue | null): YType[] {
  const out: YType[] = [];
  if (content === null || content.isNull() || content.isUndefined()) return out;
  if (content.tag !== T_ARRAY) throw new Error("Invalid content for node");
  let runs: TextRun[] = [];
  const flush = (): void => {
    if (runs.length > 0) out.push(textType(runs));
    runs = [];
  };
  for (const c of content.items) {
    if (c.tag !== T_OBJECT) throw new Error("Invalid input for Node.fromJSON");
    const type = c.get("type");
    if (type === null || type.tag !== T_STRING) throw new Error("Invalid input for Node.fromJSON");
    if (type.s === "text") {
      const text = c.get("text");
      if (text === null || text.tag !== T_STRING) throw new Error("Invalid text node in JSON");
      if (text.s.length === 0) throw new Error("Empty text nodes are not allowed");
      const marks = readMarks(schema, c);
      const last = runs.length > 0 ? runs[runs.length - 1]! : null;
      // Fragment.fromArray joins neighbouring text nodes with the same marks
      if (last !== null && sameMarks(last.marks, marks)) last.text += text.s;
      else runs.push(new TextRun(text.s, marks));
    } else {
      flush();
      out.push(readElement(schema, c, type.s));
    }
  }
  flush();
  return out;
}

function readElement(schema: PmSchema, json: YValue, name: string): YType {
  const sp = schema.nodeSpec(name);
  if (sp === null) throw new Error("Unknown node type: " + name);
  const el = YType.xmlElement(name);
  const given = json.get("attrs");
  for (let k = 0; k < sp.keys.length; k++) {
    const g = given === null ? null : given.get(sp.keys[k]!);
    const v = g !== null && !g.isUndefined() ? g : sp.defaults[k]!;
    if (!v.isNull()) el.setAttribute(sp.keys[k]!, v);
  }
  const children = readChildren(schema, json.get("content"));
  if (children.length > 0) el.insert(0, children);
  return el;
}

/**
 * Fills the (empty) fragment `field` of `doc` from ProseMirror JSON in one transaction, like
 * prosemirrorJSONToYDoc. Throws on JSON the schema does not accept.
 */
export function pmJsonToYFragment(schema: PmSchema, doc: Doc, json: string, field: string, origin: unknown = null): void {
  const root = parseJson(json);
  if (root.tag !== T_OBJECT) throw new Error("Invalid input for Node.fromJSON");
  const children = readChildren(schema, root.get("content"));
  const fragment = doc.getXmlFragment(field);
  if (children.length === 0) return;
  doc.transact(() => fragment.insert(0, children), origin);
}

/** A new document holding `json` in fragment `field`; `clientID` -1 picks a random one. */
export function pmJsonToYDoc(schema: PmSchema, json: string, field: string, clientID = -1): Doc {
  const doc = clientID >= 0 ? Doc.withClientId(clientID) : new Doc();
  pmJsonToYFragment(schema, doc, json, field, null);
  return doc;
}

/** y-prosemirror stores overlapping marks as `name--<8 chars of hash>`. */
function markNameOf(attr: string): string {
  const n = attr.length;
  if (n > 10 && attr.charCodeAt(n - 10) === 45 && attr.charCodeAt(n - 9) === 45) {
    for (let i = n - 8; i < n; i++) {
      const c = attr.charCodeAt(i);
      if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 47 || c === 61)) return attr;
    }
    return attr.substring(0, n - 10);
  }
  return attr;
}

function serialize(type: YType, out: YValue[]): void {
  if (type.kind === TYPE_XML_TEXT) {
    for (const d of type.toDelta()) {
      const text = YValue.object();
      text.set("type", YValue.string("text"));
      text.set("text", d.insert.kind === 0 ? YValue.string(d.insert.str) : d.insert.embed);
      const attrs = d.attributes;
      if (attrs !== null) {
        const marks: YValue[] = [];
        for (let i = 0; i < attrs.keys.length; i++) {
          const mark = YValue.object();
          mark.set("type", YValue.string(markNameOf(attrs.keys[i]!)));
          mark.set("attrs", attrs.items[i]!);
          marks.push(mark);
        }
        text.set("marks", YValue.array(marks));
      }
      out.push(text);
    }
    return;
  }
  if (type.kind !== TYPE_XML_ELEMENT) throw new Error("Unexpected node type");
  const node = YValue.object();
  node.set("type", YValue.string(type.nodeName));
  const attrs = type.getAttributes();
  if (attrs.keys.length > 0) node.set("attrs", attrs);
  const children = type.children();
  if (children.length > 0) {
    const content: YValue[] = [];
    for (const c of children) serialize(c, content);
    node.set("content", YValue.array(content));
  }
  out.push(node);
}

/** The fragment as ProseMirror JSON text (JSON.stringify of yXmlFragmentToProsemirrorJSON). */
export function yFragmentToPmJson(fragment: YType): string {
  const content: YValue[] = [];
  for (const c of fragment.children()) serialize(c, content);
  const doc = YValue.object();
  doc.set("type", YValue.string("doc"));
  doc.set("content", YValue.array(content));
  return stringifyJson(doc) ?? "";
}

export function yDocToPmJson(doc: Doc, field: string): string {
  return yFragmentToPmJson(doc.getXmlFragment(field));
}
