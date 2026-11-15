/**
 * A JSON-like value (what Yjs stores as "any" content, map values, format attributes and awareness states).
 * One non-generic class with a tag instead of `any`, so scriptc can compile it.
 */

export const T_UNDEFINED = 0;
export const T_NULL = 1;
export const T_BOOL = 2;
export const T_NUMBER = 3;
export const T_STRING = 4;
export const T_ARRAY = 5;
export const T_OBJECT = 6;
export const T_BYTES = 7;
/** A bigint, kept as its 8 big-endian bytes (only round-tripped, never computed with). */
export const T_BIGINT = 8;

export class YValue {
  tag = T_UNDEFINED;
  b = false;
  n = 0;
  s = "";
  /** Array items, or object values (parallel to `keys`). */
  items: YValue[] = [];
  keys: string[] = [];
  bytes: Uint8Array = new Uint8Array(0);

  static undefined(): YValue {
    return new YValue();
  }

  static null(): YValue {
    const v = new YValue();
    v.tag = T_NULL;
    return v;
  }

  static bool(b: boolean): YValue {
    const v = new YValue();
    v.tag = T_BOOL;
    v.b = b;
    return v;
  }

  static number(n: number): YValue {
    const v = new YValue();
    v.tag = T_NUMBER;
    v.n = n;
    return v;
  }

  static string(s: string): YValue {
    const v = new YValue();
    v.tag = T_STRING;
    v.s = s;
    return v;
  }

  static array(items: YValue[]): YValue {
    const v = new YValue();
    v.tag = T_ARRAY;
    v.items = items;
    return v;
  }

  static object(): YValue {
    const v = new YValue();
    v.tag = T_OBJECT;
    return v;
  }

  static bytes(bytes: Uint8Array): YValue {
    const v = new YValue();
    v.tag = T_BYTES;
    v.bytes = bytes;
    return v;
  }

  isNull(): boolean {
    return this.tag === T_NULL;
  }

  isUndefined(): boolean {
    return this.tag === T_UNDEFINED;
  }

  /** Object property (undefined value if missing or not an object). */
  get(key: string): YValue | null {
    if (this.tag !== T_OBJECT) return null;
    for (let i = 0; i < this.keys.length; i++) if (this.keys[i] === key) return this.items[i]!;
    return null;
  }

  /** Sets an object property with JavaScript's key order: array-index keys first (ascending), then insertion order. */
  set(key: string, value: YValue): void {
    for (let i = 0; i < this.keys.length; i++) {
      if (this.keys[i] === key) {
        this.items[i] = value;
        return;
      }
    }
    const idx = arrayIndex(key);
    if (idx >= 0) {
      let at = 0;
      while (at < this.keys.length) {
        const k = arrayIndex(this.keys[at]!);
        if (k < 0 || k > idx) break;
        at++;
      }
      this.keys.splice(at, 0, key);
      this.items.splice(at, 0, value);
      return;
    }
    this.keys.push(key);
    this.items.push(value);
  }

  delete(key: string): void {
    for (let i = 0; i < this.keys.length; i++) {
      if (this.keys[i] === key) {
        this.keys.splice(i, 1);
        this.items.splice(i, 1);
        return;
      }
    }
  }
}

/** The integer a canonical array-index key stands for, or -1 (JavaScript orders such keys first). */
function arrayIndex(key: string): number {
  const n = key.length;
  if (n === 0 || n > 10) return -1;
  if (n > 1 && key.charCodeAt(0) === 48) return -1;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const c = key.charCodeAt(i);
    if (c < 48 || c > 57) return -1;
    v = v * 10 + (c - 48);
  }
  return v < 4294967295 ? v : -1;
}

/** `===` semantics: primitives by value, arrays/objects/bytes by identity. */
export function strictEquals(a: YValue, b: YValue): boolean {
  if (a === b) return true;
  if (a.tag !== b.tag) return false;
  switch (a.tag) {
    case T_UNDEFINED:
    case T_NULL:
      return true;
    case T_BOOL:
      return a.b === b.b;
    case T_NUMBER:
      return a.n === b.n;
    case T_STRING:
      return a.s === b.s;
    default:
      return false;
  }
}

/** Yjs' `equalAttrs`: identical, or two objects with the same keys whose values are `===`. */
export function equalAttrs(a: YValue, b: YValue): boolean {
  if (strictEquals(a, b)) return true;
  if (a.tag !== T_OBJECT && a.tag !== T_ARRAY) return false;
  if (b.tag !== T_OBJECT && b.tag !== T_ARRAY) return false;
  // lib0 object.equalFlat: same number of keys, and a[key] === b[key] for each key of a
  const ak = flatKeys(a);
  const bk = flatKeys(b);
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    const key = ak[i]!;
    const bv = flatGet(b, key);
    if (bv === null) return false;
    if (!strictEquals(flatGet(a, key)!, bv)) return false;
  }
  return true;
}

function flatKeys(v: YValue): string[] {
  if (v.tag === T_OBJECT) return v.keys;
  const out: string[] = [];
  for (let i = 0; i < v.items.length; i++) out.push(String(i));
  return out;
}

function flatGet(v: YValue, key: string): YValue | null {
  if (v.tag === T_OBJECT) return v.get(key);
  const i = arrayIndex(key);
  return i >= 0 && i < v.items.length ? v.items[i]! : null;
}

/** Deep structural equality (lib0 `equalityDeep`). */
export function deepEquals(a: YValue, b: YValue): boolean {
  if (a === b) return true;
  if (a.tag !== b.tag) return false;
  switch (a.tag) {
    case T_UNDEFINED:
    case T_NULL:
      return true;
    case T_BOOL:
      return a.b === b.b;
    case T_NUMBER:
      return a.n === b.n;
    case T_STRING:
      return a.s === b.s;
    case T_ARRAY:
      if (a.items.length !== b.items.length) return false;
      for (let i = 0; i < a.items.length; i++) if (!deepEquals(a.items[i]!, b.items[i]!)) return false;
      return true;
    case T_OBJECT: {
      if (a.keys.length !== b.keys.length) return false;
      for (let i = 0; i < a.keys.length; i++) {
        const other = b.get(a.keys[i]!);
        if (other === null || !deepEquals(a.items[i]!, other)) return false;
      }
      return true;
    }
    default: {
      if (a.bytes.length !== b.bytes.length) return false;
      for (let i = 0; i < a.bytes.length; i++) if (a.bytes[i] !== b.bytes[i]) return false;
      return true;
    }
  }
}

// ---------------------------------------------------------------- JSON.parse / JSON.stringify

class JsonReader {
  pos = 0;
  constructor(readonly src: string) {}
}

function skipWs(r: JsonReader): void {
  while (r.pos < r.src.length) {
    const c = r.src.charCodeAt(r.pos);
    if (c === 32 || c === 10 || c === 13 || c === 9) r.pos++;
    else break;
  }
}

function hexVal(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  throw new SyntaxError("Bad Unicode escape in JSON");
}

function readJsonString(r: JsonReader): string {
  r.pos++;
  let out = "";
  let start = r.pos;
  for (;;) {
    if (r.pos >= r.src.length) throw new SyntaxError("Unterminated string in JSON");
    const c = r.src.charCodeAt(r.pos);
    if (c === 34) {
      out += r.src.substring(start, r.pos);
      r.pos++;
      return out;
    }
    if (c < 32) throw new SyntaxError("Bad control character in string literal in JSON");
    if (c === 92) {
      out += r.src.substring(start, r.pos);
      const e = r.src.charCodeAt(r.pos + 1);
      r.pos += 2;
      if (e === 110) out += "\n";
      else if (e === 116) out += "\t";
      else if (e === 114) out += "\r";
      else if (e === 98) out += "\b";
      else if (e === 102) out += "\f";
      else if (e === 34 || e === 92 || e === 47) out += String.fromCharCode(e);
      else if (e === 117) {
        if (r.pos + 4 > r.src.length) throw new SyntaxError("Bad Unicode escape in JSON");
        const code = hexVal(r.src.charCodeAt(r.pos)) * 4096 + hexVal(r.src.charCodeAt(r.pos + 1)) * 256 + hexVal(r.src.charCodeAt(r.pos + 2)) * 16 + hexVal(r.src.charCodeAt(r.pos + 3));
        out += String.fromCharCode(code);
        r.pos += 4;
      } else throw new SyntaxError("Bad escaped character in JSON");
      start = r.pos;
    } else r.pos++;
  }
}

function readJsonValue(r: JsonReader): YValue {
  skipWs(r);
  if (r.pos >= r.src.length) throw new SyntaxError("Unexpected end of JSON input");
  const c = r.src.charCodeAt(r.pos);
  if (c === 123) {
    const v = YValue.object();
    r.pos++;
    skipWs(r);
    if (r.src.charCodeAt(r.pos) === 125) {
      r.pos++;
      return v;
    }
    for (;;) {
      skipWs(r);
      if (r.src.charCodeAt(r.pos) !== 34) throw new SyntaxError("Expected property name in JSON");
      const key = readJsonString(r);
      skipWs(r);
      if (r.src.charCodeAt(r.pos) !== 58) throw new SyntaxError("Expected ':' in JSON");
      r.pos++;
      v.set(key, readJsonValue(r));
      skipWs(r);
      const d = r.src.charCodeAt(r.pos);
      r.pos++;
      if (d === 125) return v;
      if (d !== 44) throw new SyntaxError("Expected ',' or '}' in JSON");
    }
  }
  if (c === 91) {
    const v = YValue.array([]);
    r.pos++;
    skipWs(r);
    if (r.src.charCodeAt(r.pos) === 93) {
      r.pos++;
      return v;
    }
    for (;;) {
      v.items.push(readJsonValue(r));
      skipWs(r);
      const d = r.src.charCodeAt(r.pos);
      r.pos++;
      if (d === 93) return v;
      if (d !== 44) throw new SyntaxError("Expected ',' or ']' in JSON");
    }
  }
  if (c === 34) return YValue.string(readJsonString(r));
  if (r.src.startsWith("true", r.pos)) {
    r.pos += 4;
    return YValue.bool(true);
  }
  if (r.src.startsWith("false", r.pos)) {
    r.pos += 5;
    return YValue.bool(false);
  }
  if (r.src.startsWith("null", r.pos)) {
    r.pos += 4;
    return YValue.null();
  }
  const start = r.pos;
  if (r.src.charCodeAt(r.pos) === 45) r.pos++;
  while (r.pos < r.src.length) {
    const d = r.src.charCodeAt(r.pos);
    if ((d >= 48 && d <= 57) || d === 43 || d === 45 || d === 46 || d === 101 || d === 69) r.pos++;
    else break;
  }
  if (r.pos === start) throw new SyntaxError("Unexpected token in JSON");
  const n = Number(r.src.substring(start, r.pos));
  if (Number.isNaN(n)) throw new SyntaxError("Bad number in JSON");
  return YValue.number(n);
}

/** `JSON.parse` into a YValue (object key order as JavaScript would keep it). */
export function parseJson(src: string): YValue {
  const r = new JsonReader(src);
  const v = readJsonValue(r);
  skipWs(r);
  if (r.pos !== src.length) throw new SyntaxError("Unexpected non-whitespace character after JSON");
  return v;
}

const HEX = "0123456789abcdef";

function hex4(n: number): string {
  return HEX.charAt((n >> 12) & 15) + HEX.charAt((n >> 8) & 15) + HEX.charAt((n >> 4) & 15) + HEX.charAt(n & 15);
}

/** `JSON.stringify` of a string (well-formed: lone surrogates escaped). */
export function quoteJson(s: string): string {
  let out = '"';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = "";
    if (c === 34) rep = '\\"';
    else if (c === 92) rep = "\\\\";
    else if (c === 10) rep = "\\n";
    else if (c === 13) rep = "\\r";
    else if (c === 9) rep = "\\t";
    else if (c === 8) rep = "\\b";
    else if (c === 12) rep = "\\f";
    else if (c < 32) rep = "\\u" + hex4(c);
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      rep = "\\u" + hex4(c);
    } else if (c >= 0xdc00 && c <= 0xdfff) rep = "\\u" + hex4(c);
    if (rep !== "") {
      out += s.substring(start, i) + rep;
      start = i + 1;
    }
  }
  return out + s.substring(start) + '"';
}

function numberJson(n: number): string {
  if (!Number.isFinite(n)) return "null";
  if (n === 0) return "0";
  return String(n);
}

/** `JSON.stringify`; returns null where JavaScript returns `undefined` (top-level undefined). */
export function stringifyJson(v: YValue): string | null {
  switch (v.tag) {
    case T_UNDEFINED:
      return null;
    case T_NULL:
      return "null";
    case T_BOOL:
      return v.b ? "true" : "false";
    case T_NUMBER:
      return numberJson(v.n);
    case T_STRING:
      return quoteJson(v.s);
    case T_BIGINT:
      throw new TypeError("Do not know how to serialize a BigInt");
    case T_ARRAY: {
      let out = "[";
      for (let i = 0; i < v.items.length; i++) {
        const s = stringifyJson(v.items[i]!);
        out += (i > 0 ? "," : "") + (s === null ? "null" : s);
      }
      return out + "]";
    }
    case T_BYTES: {
      let out = "{";
      for (let i = 0; i < v.bytes.length; i++) out += (i > 0 ? "," : "") + '"' + i + '":' + v.bytes[i];
      return out + "}";
    }
    default: {
      let out = "{";
      let first = true;
      for (let i = 0; i < v.keys.length; i++) {
        const s = stringifyJson(v.items[i]!);
        if (s === null) continue;
        out += (first ? "" : ",") + quoteJson(v.keys[i]!) + ":" + s;
        first = false;
      }
      return out + "}";
    }
  }
}
