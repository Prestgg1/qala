/**
 * lib0-compatible binary encoding: varUint, varInt, varString, varUint8Array, float32/64 and `any`.
 */
import { T_ARRAY, T_BIGINT, T_BOOL, T_BYTES, T_NULL, T_NUMBER, T_OBJECT, T_STRING, T_UNDEFINED, YValue } from "./value";

const scratch = Buffer.alloc(8);

export class Encoder {
  buf: Uint8Array = new Uint8Array(256);
  pos = 0;

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos), 0);
    this.buf = next;
  }

  writeUint8(n: number): void {
    this.ensure(1);
    this.buf[this.pos++] = n & 255;
  }

  writeBytes(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }

  writeVarUint(num: number): void {
    while (num > 127) {
      this.writeUint8(128 | (num % 128));
      num = Math.floor(num / 128);
    }
    this.writeUint8(num % 128);
  }

  writeVarInt(num: number): void {
    const isNegative = num !== 0 ? num < 0 : 1 / num < 0;
    if (isNegative) num = -num;
    this.writeUint8((num > 63 ? 128 : 0) | (isNegative ? 64 : 0) | (num % 64));
    num = Math.floor(num / 64);
    while (num > 0) {
      this.writeUint8((num > 127 ? 128 : 0) | (num % 128));
      num = Math.floor(num / 128);
    }
  }

  writeVarUint8Array(bytes: Uint8Array): void {
    this.writeVarUint(bytes.length);
    this.writeBytes(bytes);
  }

  writeVarString(s: string): void {
    this.writeVarUint8Array(encodeUtf8(s));
  }

  writeFloat32(n: number): void {
    scratch.writeFloatBE(n, 0);
    for (let i = 0; i < 4; i++) this.writeUint8(scratch[i]!);
  }

  writeFloat64(n: number): void {
    scratch.writeDoubleBE(n, 0);
    for (let i = 0; i < 8; i++) this.writeUint8(scratch[i]!);
  }

  writeAny(v: YValue): void {
    switch (v.tag) {
      case T_STRING:
        this.writeUint8(119);
        this.writeVarString(v.s);
        return;
      case T_NUMBER: {
        const n = v.n;
        if (Number.isInteger(n) && Math.abs(n) <= 2147483647) {
          this.writeUint8(125);
          this.writeVarInt(n);
        } else if (Math.fround(n) === n) {
          this.writeUint8(124);
          this.writeFloat32(n);
        } else {
          this.writeUint8(123);
          this.writeFloat64(n);
        }
        return;
      }
      case T_BIGINT:
        this.writeUint8(122);
        this.writeBytes(v.bytes);
        return;
      case T_NULL:
        this.writeUint8(126);
        return;
      case T_ARRAY:
        this.writeUint8(117);
        this.writeVarUint(v.items.length);
        for (let i = 0; i < v.items.length; i++) this.writeAny(v.items[i]!);
        return;
      case T_BYTES:
        this.writeUint8(116);
        this.writeVarUint8Array(v.bytes);
        return;
      case T_OBJECT:
        this.writeUint8(118);
        this.writeVarUint(v.keys.length);
        for (let i = 0; i < v.keys.length; i++) {
          this.writeVarString(v.keys[i]!);
          this.writeAny(v.items[i]!);
        }
        return;
      case T_BOOL:
        this.writeUint8(v.b ? 120 : 121);
        return;
      default:
        this.writeUint8(127);
    }
  }

  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

export class Decoder {
  pos = 0;
  constructor(readonly arr: Uint8Array) {}

  hasContent(): boolean {
    return this.pos < this.arr.length;
  }

  readUint8(): number {
    if (this.pos >= this.arr.length) throw new Error("Unexpected end of array");
    return this.arr[this.pos++]!;
  }

  readBytes(len: number): Uint8Array {
    if (this.pos + len > this.arr.length) throw new Error("Unexpected end of array");
    const out = this.arr.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  readVarUint(): number {
    let num = 0;
    let mult = 1;
    while (this.pos < this.arr.length) {
      const r = this.arr[this.pos++]!;
      num = num + (r & 127) * mult;
      mult *= 128;
      if (r < 128) return num;
      if (num > Number.MAX_SAFE_INTEGER) throw new Error("Integer out of range");
    }
    throw new Error("Unexpected end of array");
  }

  readVarInt(): number {
    let r = this.readUint8();
    let num = r & 63;
    let mult = 64;
    const sign = (r & 64) > 0 ? -1 : 1;
    if ((r & 128) === 0) return sign * num;
    while (this.pos < this.arr.length) {
      r = this.arr[this.pos++]!;
      num = num + (r & 127) * mult;
      mult *= 128;
      if (r < 128) return sign * num;
      if (num > Number.MAX_SAFE_INTEGER) throw new Error("Integer out of range");
    }
    throw new Error("Unexpected end of array");
  }

  readVarUint8Array(): Uint8Array {
    return this.readBytes(this.readVarUint());
  }

  readVarString(): string {
    return decodeUtf8(this.readVarUint8Array());
  }

  readFloat32(): number {
    const b = this.readBytes(4);
    for (let i = 0; i < 4; i++) scratch[i] = b[i]!;
    return scratch.readFloatBE(0);
  }

  readFloat64(): number {
    const b = this.readBytes(8);
    for (let i = 0; i < 8; i++) scratch[i] = b[i]!;
    return scratch.readDoubleBE(0);
  }

  readAny(): YValue {
    const t = this.readUint8();
    switch (t) {
      case 127:
        return YValue.undefined();
      case 126:
        return YValue.null();
      case 125:
        return YValue.number(this.readVarInt());
      case 124:
        return YValue.number(this.readFloat32());
      case 123:
        return YValue.number(this.readFloat64());
      case 122: {
        const v = new YValue();
        v.tag = T_BIGINT;
        v.bytes = this.readBytes(8).slice();
        return v;
      }
      case 121:
        return YValue.bool(false);
      case 120:
        return YValue.bool(true);
      case 119:
        return YValue.string(this.readVarString());
      case 118: {
        const len = this.readVarUint();
        const obj = YValue.object();
        for (let i = 0; i < len; i++) {
          const key = this.readVarString();
          obj.set(key, this.readAny());
        }
        return obj;
      }
      case 117: {
        const len = this.readVarUint();
        const items: YValue[] = [];
        for (let i = 0; i < len; i++) items.push(this.readAny());
        return YValue.array(items);
      }
      case 116:
        return YValue.bytes(this.readVarUint8Array().slice());
      default:
        throw new Error("Unknown any type " + t);
    }
  }
}

/** UTF-8 like TextEncoder (lone surrogates become U+FFFD). */
export function encodeUtf8(s: string): Uint8Array {
  let ascii = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  const out = new Uint8Array(ascii ? s.length : s.length * 3);
  let p = 0;
  if (ascii) {
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + (c - 0xd800) * 1024 + (d - 0xdc00);
        i++;
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out[p++] = c;
    else if (c < 0x800) {
      out[p++] = 0xc0 | (c >> 6);
      out[p++] = 0x80 | (c & 63);
    } else if (c < 0x10000) {
      out[p++] = 0xe0 | (c >> 12);
      out[p++] = 0x80 | ((c >> 6) & 63);
      out[p++] = 0x80 | (c & 63);
    } else {
      out[p++] = 0xf0 | (c >> 18);
      out[p++] = 0x80 | ((c >> 12) & 63);
      out[p++] = 0x80 | ((c >> 6) & 63);
      out[p++] = 0x80 | (c & 63);
    }
  }
  return out.slice(0, p);
}

/** UTF-8 like TextDecoder("utf-8", { fatal: false, ignoreBOM: true }): invalid sequences become U+FFFD. */
export function decodeUtf8(bytes: Uint8Array): string {
  let out = "";
  let chunk = "";
  let needed = 0;
  let seen = 0;
  let cp = 0;
  let lower = 0x80;
  let upper = 0xbf;
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i]!;
    if (needed === 0) {
      i++;
      if (b <= 0x7f) chunk += String.fromCharCode(b);
      else if (b >= 0xc2 && b <= 0xdf) {
        needed = 1;
        cp = b & 0x1f;
      } else if (b >= 0xe0 && b <= 0xef) {
        if (b === 0xe0) lower = 0xa0;
        if (b === 0xed) upper = 0x9f;
        needed = 2;
        cp = b & 0xf;
      } else if (b >= 0xf0 && b <= 0xf4) {
        if (b === 0xf0) lower = 0x90;
        if (b === 0xf4) upper = 0x8f;
        needed = 3;
        cp = b & 7;
      } else chunk += "�";
    } else {
      if (b < lower || b > upper) {
        cp = 0;
        needed = 0;
        seen = 0;
        lower = 0x80;
        upper = 0xbf;
        chunk += "�";
        continue; // reprocess this byte
      }
      i++;
      lower = 0x80;
      upper = 0xbf;
      cp = cp * 64 + (b & 0x3f);
      seen++;
      if (seen === needed) {
        if (cp < 0x10000) chunk += String.fromCharCode(cp);
        else {
          const v = cp - 0x10000;
          chunk += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 1023));
        }
        cp = 0;
        needed = 0;
        seen = 0;
      }
    }
    if (chunk.length > 4096) {
      out += chunk;
      chunk = "";
    }
  }
  if (needed !== 0) chunk += "�";
  return out + chunk;
}
