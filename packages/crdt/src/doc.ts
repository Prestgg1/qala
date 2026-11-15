/**
 * The CRDT core: a partial port of Yjs 13.6 (structs, YATA integration, transactions, garbage collection,
 * update encoding v1, Y.Map / Y.XmlFragment / Y.XmlElement / Y.XmlText / Y.Text).
 *
 * Written for scriptc's static subset: one non-generic class per concept with tag fields (no inheritance
 * between struct kinds or type kinds), YValue instead of `any`.
 */
import { Decoder, Encoder } from "./encoding";
import { equalAttrs, parseJson, strictEquals, stringifyJson, T_OBJECT, T_UNDEFINED, YValue } from "./value";

// ---------------------------------------------------------------- IDs

export class ID {
  constructor(
    public client: number,
    public clock: number,
  ) {}
}

export function compareIDs(a: ID | null, b: ID | null): boolean {
  return a === b || (a !== null && b !== null && a.client === b.client && a.clock === b.clock);
}

// ---------------------------------------------------------------- content

export const CONTENT_DELETED = 1;
export const CONTENT_JSON = 2;
export const CONTENT_BINARY = 3;
export const CONTENT_STRING = 4;
export const CONTENT_EMBED = 5;
export const CONTENT_FORMAT = 6;
export const CONTENT_TYPE = 7;
export const CONTENT_ANY = 8;

/** Item content; `ref` is the Yjs content reference number. */
export class Content {
  str = "";
  /** ContentAny / ContentJSON values. */
  arr: YValue[] = [];
  len = 0;
  key = "";
  value: YValue = YValue.null();
  type: YType | null = null;
  buf: Uint8Array = new Uint8Array(0);

  constructor(readonly ref: number) {}

  static deleted(len: number): Content {
    const c = new Content(CONTENT_DELETED);
    c.len = len;
    return c;
  }

  static string(str: string): Content {
    const c = new Content(CONTENT_STRING);
    c.str = str;
    return c;
  }

  static any(arr: YValue[]): Content {
    const c = new Content(CONTENT_ANY);
    c.arr = arr;
    return c;
  }

  static json(arr: YValue[]): Content {
    const c = new Content(CONTENT_JSON);
    c.arr = arr;
    return c;
  }

  static format(key: string, value: YValue): Content {
    const c = new Content(CONTENT_FORMAT);
    c.key = key;
    c.value = value;
    return c;
  }

  static embed(value: YValue): Content {
    const c = new Content(CONTENT_EMBED);
    c.value = value;
    return c;
  }

  static binary(buf: Uint8Array): Content {
    const c = new Content(CONTENT_BINARY);
    c.buf = buf;
    return c;
  }

  static ofType(type: YType): Content {
    const c = new Content(CONTENT_TYPE);
    c.type = type;
    return c;
  }

  getLength(): number {
    switch (this.ref) {
      case CONTENT_DELETED:
        return this.len;
      case CONTENT_STRING:
        return this.str.length;
      case CONTENT_ANY:
      case CONTENT_JSON:
        return this.arr.length;
      default:
        return 1;
    }
  }

  isCountable(): boolean {
    return this.ref !== CONTENT_DELETED && this.ref !== CONTENT_FORMAT;
  }

  copy(): Content {
    switch (this.ref) {
      case CONTENT_DELETED:
        return Content.deleted(this.len);
      case CONTENT_STRING:
        return Content.string(this.str);
      case CONTENT_ANY:
        return Content.any(this.arr);
      case CONTENT_JSON:
        return Content.json(this.arr);
      case CONTENT_FORMAT:
        return Content.format(this.key, this.value);
      case CONTENT_EMBED:
        return Content.embed(this.value);
      case CONTENT_BINARY:
        return Content.binary(this.buf);
      default:
        return Content.ofType(this.type!.copyEmpty());
    }
  }

  /** Splits at `offset`: this keeps [0, offset), the returned content holds the rest. */
  splice(offset: number): Content {
    switch (this.ref) {
      case CONTENT_DELETED: {
        const right = Content.deleted(this.len - offset);
        this.len = offset;
        return right;
      }
      case CONTENT_STRING: {
        const right = Content.string(this.str.slice(offset));
        this.str = this.str.slice(0, offset);
        const firstCharCode = this.str.charCodeAt(offset - 1);
        if (firstCharCode >= 0xd800 && firstCharCode <= 0xdbff) {
          // a surrogate pair was split: both halves become replacement characters (as Yjs does)
          this.str = this.str.slice(0, offset - 1) + "�";
          right.str = "�" + right.str.slice(1);
        }
        return right;
      }
      case CONTENT_ANY: {
        const right = Content.any(this.arr.slice(offset));
        this.arr = this.arr.slice(0, offset);
        return right;
      }
      case CONTENT_JSON: {
        const right = Content.json(this.arr.slice(offset));
        this.arr = this.arr.slice(0, offset);
        return right;
      }
      default:
        throw new Error("This content cannot be split");
    }
  }

  mergeWith(right: Content): boolean {
    switch (this.ref) {
      case CONTENT_DELETED:
        this.len += right.len;
        return true;
      case CONTENT_STRING:
        this.str += right.str;
        return true;
      case CONTENT_ANY:
      case CONTENT_JSON:
        this.arr = this.arr.concat(right.arr);
        return true;
      default:
        return false;
    }
  }

  integrate(transaction: Transaction, item: Item): void {
    if (this.ref === CONTENT_DELETED) {
      addToDeleteSet(transaction.deleteSet, item.id.client, item.id.clock, this.len);
      item.markDeleted();
    } else if (this.ref === CONTENT_FORMAT) {
      item.parent!.hasFormatting = true;
    } else if (this.ref === CONTENT_TYPE) {
      this.type!.integrateInto(transaction.doc, item);
    }
  }

  delete(transaction: Transaction): void {
    if (this.ref !== CONTENT_TYPE) return;
    const type = this.type!;
    let item = type._start;
    while (item !== null) {
      if (!item.deleted) item.delete(transaction);
      else if (item.id.clock < (transaction.beforeState.get(item.id.client) ?? 0)) transaction._mergeStructs.push(item);
      item = item.right;
    }
    for (const entry of type._map.values()) {
      if (!entry.deleted) entry.delete(transaction);
      else if (entry.id.clock < (transaction.beforeState.get(entry.id.client) ?? 0)) transaction._mergeStructs.push(entry);
    }
    transaction.changed.delete(type);
  }

  gc(store: StructStore): void {
    if (this.ref !== CONTENT_TYPE) return;
    const type = this.type!;
    let item = type._start;
    while (item !== null) {
      item.gc(store, true);
      item = item.right;
    }
    type._start = null;
    for (const entry of type._map.values()) {
      let it: Item | null = entry;
      while (it !== null) {
        it.gc(store, true);
        it = it.left;
      }
    }
    type._map = new Map<string, Item>();
  }

  write(encoder: Encoder, offset: number): void {
    switch (this.ref) {
      case CONTENT_DELETED:
        encoder.writeVarUint(this.len - offset);
        return;
      case CONTENT_JSON: {
        encoder.writeVarUint(this.arr.length - offset);
        for (let i = offset; i < this.arr.length; i++) {
          const c = this.arr[i]!;
          encoder.writeVarString(c.tag === T_UNDEFINED ? "undefined" : (stringifyJson(c) ?? "undefined"));
        }
        return;
      }
      case CONTENT_BINARY:
        encoder.writeVarUint8Array(this.buf);
        return;
      case CONTENT_STRING:
        encoder.writeVarString(offset === 0 ? this.str : this.str.slice(offset));
        return;
      case CONTENT_EMBED:
        encoder.writeVarString(stringifyJson(this.value) ?? "undefined");
        return;
      case CONTENT_FORMAT:
        encoder.writeVarString(this.key);
        encoder.writeVarString(stringifyJson(this.value) ?? "undefined");
        return;
      case CONTENT_TYPE:
        this.type!.writeTypeRef(encoder);
        return;
      default: {
        encoder.writeVarUint(this.arr.length - offset);
        for (let i = offset; i < this.arr.length; i++) encoder.writeAny(this.arr[i]!);
      }
    }
  }
}

function readContent(decoder: Decoder, info: number): Content {
  switch (info & 31) {
    case CONTENT_DELETED:
      return Content.deleted(decoder.readVarUint());
    case CONTENT_JSON: {
      const len = decoder.readVarUint();
      const arr: YValue[] = [];
      for (let i = 0; i < len; i++) {
        const c = decoder.readVarString();
        arr.push(c === "undefined" ? YValue.undefined() : parseJson(c));
      }
      return Content.json(arr);
    }
    case CONTENT_BINARY:
      return Content.binary(decoder.readVarUint8Array().slice());
    case CONTENT_STRING:
      return Content.string(decoder.readVarString());
    case CONTENT_EMBED:
      return Content.embed(parseJson(decoder.readVarString()));
    case CONTENT_FORMAT: {
      const key = decoder.readVarString();
      return Content.format(key, parseJson(decoder.readVarString()));
    }
    case CONTENT_TYPE: {
      const ref = decoder.readVarUint();
      const type = new YType(ref);
      if (ref === TYPE_XML_ELEMENT || ref === TYPE_XML_HOOK) type.nodeName = decoder.readVarString();
      return Content.ofType(type);
    }
    case CONTENT_ANY: {
      const len = decoder.readVarUint();
      const arr: YValue[] = [];
      for (let i = 0; i < len; i++) arr.push(decoder.readAny());
      return Content.any(arr);
    }
    default:
      throw new Error("Unsupported content type " + (info & 31) + " (subdocuments are not supported)");
  }
}

// ---------------------------------------------------------------- structs

export const STRUCT_GC = 0;
export const STRUCT_ITEM = 1;
export const STRUCT_SKIP = 10;

const BIT_KEEP = 1;
const BIT_COUNTABLE = 2;
const BIT_DELETED = 4;

/** A struct: an Item, or a GC / Skip range (kind). */
export class Item {
  /** Left neighbour; also the struct this was integrated after. */
  left: Item | null = null;
  right: Item | null = null;
  info = 0;
  /** Unresolved parent (decoded from an update, not integrated yet). */
  parentID: ID | null = null;

  constructor(
    public kind: number,
    public id: ID,
    public length: number,
    public origin: ID | null,
    public rightOrigin: ID | null,
    public parent: YType | null,
    public parentSub: string | null,
    public content: Content,
  ) {
    if (kind === STRUCT_ITEM && content.isCountable()) this.info = BIT_COUNTABLE;
  }

  static gc(id: ID, length: number): Item {
    return new Item(STRUCT_GC, id, length, null, null, null, null, Content.deleted(length));
  }

  static skip(id: ID, length: number): Item {
    return new Item(STRUCT_SKIP, id, length, null, null, null, null, Content.deleted(length));
  }

  static create(id: ID, left: Item | null, origin: ID | null, right: Item | null, rightOrigin: ID | null, parent: YType | null, parentSub: string | null, content: Content): Item {
    const item = new Item(STRUCT_ITEM, id, content.getLength(), origin, rightOrigin, parent, parentSub, content);
    item.left = left;
    item.right = right;
    return item;
  }

  get deleted(): boolean {
    return this.kind !== STRUCT_ITEM || (this.info & BIT_DELETED) > 0;
  }

  get countable(): boolean {
    return (this.info & BIT_COUNTABLE) > 0;
  }

  get keep(): boolean {
    return (this.info & BIT_KEEP) > 0;
  }

  markDeleted(): void {
    this.info |= BIT_DELETED;
  }

  get lastId(): ID {
    return this.length === 1 ? this.id : new ID(this.id.client, this.id.clock + this.length - 1);
  }

  /** The next non-deleted item. */
  get next(): Item | null {
    let n = this.right;
    while (n !== null && n.deleted) n = n.right;
    return n;
  }

  get prev(): Item | null {
    let n = this.left;
    while (n !== null && n.deleted) n = n.left;
    return n;
  }

  /** The client whose missing state blocks integration, or -1. Resolves left/right/parent otherwise. */
  getMissing(transaction: Transaction, store: StructStore): number {
    if (this.kind !== STRUCT_ITEM) return -1;
    const origin = this.origin;
    if (origin !== null && origin.client !== this.id.client && origin.clock >= getState(store, origin.client)) return origin.client;
    const rightOrigin = this.rightOrigin;
    if (rightOrigin !== null && rightOrigin.client !== this.id.client && rightOrigin.clock >= getState(store, rightOrigin.client)) return rightOrigin.client;
    const pid = this.parentID;
    if (pid !== null && this.id.client !== pid.client && pid.clock >= getState(store, pid.client)) return pid.client;
    if (origin !== null) {
      const left = getItemCleanEnd(transaction, store, origin);
      this.left = left;
      this.origin = left.lastId;
    }
    if (rightOrigin !== null) {
      const right = getItemCleanStart(transaction, rightOrigin);
      this.right = right;
      this.rightOrigin = right.id;
    }
    const left = this.left;
    const right = this.right;
    if ((left !== null && left.kind === STRUCT_GC) || (right !== null && right.kind === STRUCT_GC)) {
      this.parent = null;
      this.parentID = null;
    } else if (this.parent === null && pid === null) {
      if (left !== null && left.kind === STRUCT_ITEM) {
        this.parent = left.parent;
        this.parentSub = left.parentSub;
      } else if (right !== null && right.kind === STRUCT_ITEM) {
        this.parent = right.parent;
        this.parentSub = right.parentSub;
      }
    } else if (pid !== null) {
      const parentItem = getItem(store, pid);
      this.parent = parentItem.kind === STRUCT_GC ? null : parentItem.content.type;
      this.parentID = null;
    }
    return -1;
  }

  integrate(transaction: Transaction, offset: number): void {
    if (this.kind === STRUCT_GC) {
      if (offset > 0) {
        this.id.clock += offset;
        this.length -= offset;
      }
      addStruct(transaction.doc.store, this);
      return;
    }
    if (this.kind === STRUCT_SKIP) throw new Error("Skip structs cannot be integrated");
    if (offset > 0) {
      this.id.clock += offset;
      const left = getItemCleanEnd(transaction, transaction.doc.store, new ID(this.id.client, this.id.clock - 1));
      this.left = left;
      this.origin = left.lastId;
      this.content = this.content.splice(offset);
      this.length -= offset;
    }
    const parent = this.parent;
    if (parent === null) {
      Item.gc(this.id, this.length).integrate(transaction, 0);
      return;
    }
    if ((this.left === null && (this.right === null || this.right.left !== null)) || (this.left !== null && this.left.right !== this.right)) {
      let left = this.left;
      let o: Item | null;
      if (left !== null) o = left.right;
      else if (this.parentSub !== null) {
        o = parent._map.get(this.parentSub) ?? null;
        while (o !== null && o.left !== null) o = o.left;
      } else o = parent._start;
      const conflictingItems = new Set<Item>();
      const itemsBeforeOrigin = new Set<Item>();
      while (o !== null && o !== this.right) {
        itemsBeforeOrigin.add(o);
        conflictingItems.add(o);
        if (compareIDs(this.origin, o.origin)) {
          if (o.id.client < this.id.client) {
            left = o;
            conflictingItems.clear();
          } else if (compareIDs(this.rightOrigin, o.rightOrigin)) {
            break;
          }
        } else if (o.origin !== null && itemsBeforeOrigin.has(getItem(transaction.doc.store, o.origin))) {
          if (!conflictingItems.has(getItem(transaction.doc.store, o.origin))) {
            left = o;
            conflictingItems.clear();
          }
        } else {
          break;
        }
        o = o.right;
      }
      this.left = left;
    }
    if (this.left !== null) {
      const right = this.left.right;
      this.right = right;
      this.left.right = this;
    } else {
      let r: Item | null;
      if (this.parentSub !== null) {
        r = parent._map.get(this.parentSub) ?? null;
        while (r !== null && r.left !== null) r = r.left;
      } else {
        r = parent._start;
        parent._start = this;
      }
      this.right = r;
    }
    if (this.right !== null) {
      this.right.left = this;
    } else if (this.parentSub !== null) {
      parent._map.set(this.parentSub, this);
      if (this.left !== null) this.left.delete(transaction);
    }
    if (this.parentSub === null && this.countable && !this.deleted) parent._length += this.length;
    addStruct(transaction.doc.store, this);
    this.content.integrate(transaction, this);
    addChangedTypeToTransaction(transaction, parent);
    if ((parent._item !== null && parent._item.deleted) || (this.parentSub !== null && this.right !== null)) this.delete(transaction);
  }

  mergeWith(right: Item): boolean {
    if (this.kind !== STRUCT_ITEM) {
      if (this.kind !== right.kind) return false;
      this.length += right.length;
      return true;
    }
    if (
      right.kind === STRUCT_ITEM &&
      compareIDs(right.origin, this.lastId) &&
      this.right === right &&
      compareIDs(this.rightOrigin, right.rightOrigin) &&
      this.id.client === right.id.client &&
      this.id.clock + this.length === right.id.clock &&
      this.deleted === right.deleted &&
      this.content.ref === right.content.ref &&
      this.content.mergeWith(right.content)
    ) {
      if (right.keep) this.info |= BIT_KEEP;
      this.right = right.right;
      if (this.right !== null) this.right.left = this;
      this.length += right.length;
      return true;
    }
    return false;
  }

  delete(transaction: Transaction): void {
    if (this.kind !== STRUCT_ITEM || this.deleted) return;
    const parent = this.parent!;
    if (this.countable && this.parentSub === null) parent._length -= this.length;
    this.markDeleted();
    addToDeleteSet(transaction.deleteSet, this.id.client, this.id.clock, this.length);
    addChangedTypeToTransaction(transaction, parent);
    this.content.delete(transaction);
  }

  gc(store: StructStore, parentGCd: boolean): void {
    if (!this.deleted) throw new Error("Unexpected case: gc of a live item");
    this.content.gc(store);
    if (parentGCd) replaceStruct(store, this, Item.gc(this.id, this.length));
    else this.content = Content.deleted(this.length);
  }

  write(encoder: Encoder, offset: number): void {
    if (this.kind === STRUCT_GC) {
      encoder.writeUint8(0);
      encoder.writeVarUint(this.length - offset);
      return;
    }
    if (this.kind === STRUCT_SKIP) {
      encoder.writeUint8(10);
      encoder.writeVarUint(this.length - offset);
      return;
    }
    const origin = offset > 0 ? new ID(this.id.client, this.id.clock + offset - 1) : this.origin;
    const rightOrigin = this.rightOrigin;
    const parentSub = this.parentSub;
    const info = (this.content.ref & 31) | (origin === null ? 0 : 128) | (rightOrigin === null ? 0 : 64) | (parentSub === null ? 0 : 32);
    encoder.writeUint8(info);
    if (origin !== null) {
      encoder.writeVarUint(origin.client);
      encoder.writeVarUint(origin.clock);
    }
    if (rightOrigin !== null) {
      encoder.writeVarUint(rightOrigin.client);
      encoder.writeVarUint(rightOrigin.clock);
    }
    if (origin === null && rightOrigin === null) {
      const parent = this.parent;
      if (parent !== null) {
        const parentItem = parent._item;
        if (parentItem === null) {
          encoder.writeVarUint(1);
          encoder.writeVarString(findRootTypeKey(parent));
        } else {
          encoder.writeVarUint(0);
          encoder.writeVarUint(parentItem.id.client);
          encoder.writeVarUint(parentItem.id.clock);
        }
      } else if (this.parentID !== null) {
        encoder.writeVarUint(0);
        encoder.writeVarUint(this.parentID.client);
        encoder.writeVarUint(this.parentID.clock);
      } else {
        throw new Error("Unexpected case: item without parent");
      }
      if (parentSub !== null) encoder.writeVarString(parentSub);
    }
    this.content.write(encoder, offset);
  }
}

/** Splits `leftItem` at `diff`; returns the right part. */
export function splitItem(transaction: Transaction, leftItem: Item, diff: number): Item {
  const client = leftItem.id.client;
  const clock = leftItem.id.clock;
  const rightItem = Item.create(new ID(client, clock + diff), leftItem, new ID(client, clock + diff - 1), leftItem.right, leftItem.rightOrigin, leftItem.parent, leftItem.parentSub, leftItem.content.splice(diff));
  if (leftItem.deleted) rightItem.markDeleted();
  if (leftItem.keep) rightItem.info |= BIT_KEEP;
  leftItem.right = rightItem;
  if (rightItem.right !== null) rightItem.right.left = rightItem;
  transaction._mergeStructs.push(rightItem);
  if (rightItem.parentSub !== null && rightItem.right === null) rightItem.parent!._map.set(rightItem.parentSub, rightItem);
  leftItem.length = diff;
  return rightItem;
}

// ---------------------------------------------------------------- delete sets

export class DeleteItem {
  constructor(
    public clock: number,
    public len: number,
  ) {}
}

export class DeleteSet {
  clients = new Map<number, DeleteItem[]>();
}

export function addToDeleteSet(ds: DeleteSet, client: number, clock: number, length: number): void {
  let dels = ds.clients.get(client);
  if (dels === undefined) {
    dels = [];
    ds.clients.set(client, dels);
  }
  dels.push(new DeleteItem(clock, length));
}

function findIndexDS(dis: DeleteItem[], clock: number): number {
  let left = 0;
  let right = dis.length - 1;
  while (left <= right) {
    const midindex = Math.floor((left + right) / 2);
    const mid = dis[midindex]!;
    if (mid.clock <= clock) {
      if (clock < mid.clock + mid.len) return midindex;
      left = midindex + 1;
    } else right = midindex - 1;
  }
  return -1;
}

export function isDeleted(ds: DeleteSet, id: ID): boolean {
  const dis = ds.clients.get(id.client);
  return dis !== undefined && findIndexDS(dis, id.clock) >= 0;
}

export function sortAndMergeDeleteSet(ds: DeleteSet): void {
  for (const dels of ds.clients.values()) {
    dels.sort((a, b) => a.clock - b.clock);
    let j = 1;
    for (let i = 1; i < dels.length; i++) {
      const left = dels[j - 1]!;
      const right = dels[i]!;
      if (left.clock + left.len >= right.clock) {
        dels[j - 1] = new DeleteItem(left.clock, Math.max(left.len, right.clock + right.len - left.clock));
      } else {
        if (j < i) dels[j] = right;
        j++;
      }
    }
    dels.length = j;
  }
}

export function mergeDeleteSets(dss: DeleteSet[]): DeleteSet {
  const merged = new DeleteSet();
  for (let dssI = 0; dssI < dss.length; dssI++) {
    for (const [client, delsLeft] of dss[dssI]!.clients) {
      if (!merged.clients.has(client)) {
        const dels = delsLeft.slice();
        for (let i = dssI + 1; i < dss.length; i++) {
          const more = dss[i]!.clients.get(client);
          if (more !== undefined) for (const d of more) dels.push(d);
        }
        merged.clients.set(client, dels);
      }
    }
  }
  sortAndMergeDeleteSet(merged);
  return merged;
}

export function createDeleteSetFromStructStore(store: StructStore): DeleteSet {
  const ds = new DeleteSet();
  for (const [client, structs] of store.clients) {
    const dsitems: DeleteItem[] = [];
    for (let i = 0; i < structs.length; i++) {
      const struct = structs[i]!;
      if (struct.deleted) {
        const clock = struct.id.clock;
        let len = struct.length;
        while (i + 1 < structs.length && structs[i + 1]!.deleted) {
          i++;
          len += structs[i]!.length;
        }
        dsitems.push(new DeleteItem(clock, len));
      }
    }
    if (dsitems.length > 0) ds.clients.set(client, dsitems);
  }
  return ds;
}

function sortedClientsDesc(keys: Iterable<number>): number[] {
  const out: number[] = [];
  for (const k of keys) out.push(k);
  out.sort((a, b) => b - a);
  return out;
}

export function writeDeleteSet(encoder: Encoder, ds: DeleteSet): void {
  encoder.writeVarUint(ds.clients.size);
  for (const client of sortedClientsDesc(ds.clients.keys())) {
    const dsitems = ds.clients.get(client)!;
    encoder.writeVarUint(client);
    encoder.writeVarUint(dsitems.length);
    for (const item of dsitems) {
      encoder.writeVarUint(item.clock);
      encoder.writeVarUint(item.len);
    }
  }
}

export function readDeleteSet(decoder: Decoder): DeleteSet {
  const ds = new DeleteSet();
  const numClients = decoder.readVarUint();
  for (let i = 0; i < numClients; i++) {
    const client = decoder.readVarUint();
    const n = decoder.readVarUint();
    if (n > 0) {
      let field = ds.clients.get(client);
      if (field === undefined) {
        field = [];
        ds.clients.set(client, field);
      }
      for (let k = 0; k < n; k++) {
        const clock = decoder.readVarUint();
        field.push(new DeleteItem(clock, decoder.readVarUint()));
      }
    }
  }
  return ds;
}

/** Applies a delete set; returns the part that refers to structs we do not have yet (or null). */
function applyDeleteSet(transaction: Transaction, store: StructStore, ds: DeleteSet): DeleteSet | null {
  const unapplied = new DeleteSet();
  for (const [client, dels] of ds.clients) {
    const structs = store.clients.get(client) ?? [];
    const state = getState(store, client);
    for (const del of dels) {
      const clock = del.clock;
      const clockEnd = clock + del.len;
      if (clock < state) {
        if (state < clockEnd) addToDeleteSet(unapplied, client, state, clockEnd - state);
        let index = findIndexSS(structs, clock);
        let struct = structs[index]!;
        if (!struct.deleted && struct.id.clock < clock) {
          structs.splice(index + 1, 0, splitItem(transaction, struct, clock - struct.id.clock));
          index++;
        }
        while (index < structs.length) {
          struct = structs[index++]!;
          if (struct.id.clock < clockEnd) {
            if (!struct.deleted) {
              if (clockEnd < struct.id.clock + struct.length) structs.splice(index, 0, splitItem(transaction, struct, clockEnd - struct.id.clock));
              struct.delete(transaction);
            }
          } else break;
        }
      } else {
        addToDeleteSet(unapplied, client, clock, clockEnd - clock);
      }
    }
  }
  return unapplied.clients.size > 0 ? unapplied : null;
}

// ---------------------------------------------------------------- struct store

/** Updates we could not apply yet: decoded structs per client plus the lowest missing clock per client. */
export class PendingStructs {
  missing = new Map<number, number>();
  structs = new Map<number, Item[]>();
}

export class StructStore {
  clients = new Map<number, Item[]>();
  pendingStructs: PendingStructs | null = null;
  pendingDs: DeleteSet | null = null;
}

export function getStateVector(store: StructStore): Map<number, number> {
  const sm = new Map<number, number>();
  for (const [client, structs] of store.clients) {
    const struct = structs[structs.length - 1]!;
    sm.set(client, struct.id.clock + struct.length);
  }
  return sm;
}

export function getState(store: StructStore, client: number): number {
  const structs = store.clients.get(client);
  if (structs === undefined) return 0;
  const last = structs[structs.length - 1]!;
  return last.id.clock + last.length;
}

function addStruct(store: StructStore, struct: Item): void {
  let structs = store.clients.get(struct.id.client);
  if (structs === undefined) {
    structs = [];
    store.clients.set(struct.id.client, structs);
  } else {
    const last = structs[structs.length - 1]!;
    if (last.id.clock + last.length !== struct.id.clock) throw new Error("Unexpected case: struct store out of order");
  }
  structs.push(struct);
}

export function findIndexSS(structs: Item[], clock: number): number {
  let left = 0;
  let right = structs.length - 1;
  let mid = structs[right]!;
  let midclock = mid.id.clock;
  if (midclock === clock) return right;
  let midindex = Math.floor((clock / (midclock + mid.length - 1)) * right);
  if (!(midindex >= 0 && midindex <= right)) midindex = Math.floor((left + right) / 2);
  while (left <= right) {
    mid = structs[midindex]!;
    midclock = mid.id.clock;
    if (midclock <= clock) {
      if (clock < midclock + mid.length) return midindex;
      left = midindex + 1;
    } else right = midindex - 1;
    midindex = Math.floor((left + right) / 2);
  }
  throw new Error("Unexpected case: struct not found");
}

export function getItem(store: StructStore, id: ID): Item {
  const structs = store.clients.get(id.client)!;
  return structs[findIndexSS(structs, id.clock)]!;
}

function findIndexCleanStart(transaction: Transaction, structs: Item[], clock: number): number {
  const index = findIndexSS(structs, clock);
  const struct = structs[index]!;
  if (struct.id.clock < clock && struct.kind === STRUCT_ITEM) {
    structs.splice(index + 1, 0, splitItem(transaction, struct, clock - struct.id.clock));
    return index + 1;
  }
  return index;
}

export function getItemCleanStart(transaction: Transaction, id: ID): Item {
  const structs = transaction.doc.store.clients.get(id.client)!;
  return structs[findIndexCleanStart(transaction, structs, id.clock)]!;
}

function getItemCleanEnd(transaction: Transaction, store: StructStore, id: ID): Item {
  const structs = store.clients.get(id.client)!;
  const index = findIndexSS(structs, id.clock);
  const struct = structs[index]!;
  if (id.clock !== struct.id.clock + struct.length - 1 && struct.kind !== STRUCT_GC) {
    structs.splice(index + 1, 0, splitItem(transaction, struct, id.clock - struct.id.clock + 1));
  }
  return struct;
}

function replaceStruct(store: StructStore, struct: Item, newStruct: Item): void {
  const structs = store.clients.get(struct.id.client)!;
  structs[findIndexSS(structs, struct.id.clock)] = newStruct;
}

function iterateStructs(transaction: Transaction, structs: Item[], clockStart: number, len: number, f: (s: Item) => void): void {
  if (len === 0) return;
  const clockEnd = clockStart + len;
  let index = findIndexCleanStart(transaction, structs, clockStart);
  let struct: Item;
  do {
    struct = structs[index++]!;
    if (clockEnd < struct.id.clock + struct.length) findIndexCleanStart(transaction, structs, clockEnd);
    f(struct);
  } while (index < structs.length && structs[index]!.id.clock < clockEnd);
}

function iterateDeletedStructs(transaction: Transaction, ds: DeleteSet, f: (s: Item) => void): void {
  for (const [client, deletes] of ds.clients) {
    const structs = transaction.doc.store.clients.get(client);
    if (structs === undefined) continue;
    const last = structs[structs.length - 1]!;
    const clockState = last.id.clock + last.length;
    for (let i = 0; i < deletes.length && deletes[i]!.clock < clockState; i++) {
      const del = deletes[i]!;
      iterateStructs(transaction, structs, del.clock, del.len, f);
    }
  }
}

// ---------------------------------------------------------------- types

export const TYPE_ABSTRACT = -1;
export const TYPE_ARRAY = 0;
export const TYPE_MAP = 1;
export const TYPE_TEXT = 2;
export const TYPE_XML_ELEMENT = 3;
export const TYPE_XML_FRAGMENT = 4;
export const TYPE_XML_HOOK = 5;
export const TYPE_XML_TEXT = 6;

/** A shared type. `kind` picks the behaviour (Y.Map, Y.XmlFragment, Y.XmlElement, Y.XmlText, Y.Text, Y.Array). */
export class YType {
  _item: Item | null = null;
  _map = new Map<string, Item>();
  _start: Item | null = null;
  doc: Doc | null = null;
  _length = 0;
  /** Y.XmlElement / Y.XmlHook name. */
  nodeName = "";
  hasFormatting = false;
  /** Content and attributes given before the type is part of a document (Yjs "prelim" state). */
  private prelimChildren: ListContent[] = [];
  private prelimAttrs = new Map<string, MapContent>();
  private pending: (() => void)[] = [];
  private integrated = false;

  constructor(public kind: number) {}

  static xmlFragment(): YType {
    return new YType(TYPE_XML_FRAGMENT);
  }

  static xmlElement(nodeName: string): YType {
    const t = new YType(TYPE_XML_ELEMENT);
    t.nodeName = nodeName;
    return t;
  }

  static xmlText(): YType {
    return new YType(TYPE_XML_TEXT);
  }

  static map(): YType {
    return new YType(TYPE_MAP);
  }

  static text(): YType {
    return new YType(TYPE_TEXT);
  }

  static array(): YType {
    return new YType(TYPE_ARRAY);
  }

  get isText(): boolean {
    return this.kind === TYPE_TEXT || this.kind === TYPE_XML_TEXT;
  }

  copyEmpty(): YType {
    const t = new YType(this.kind);
    t.nodeName = this.nodeName;
    return t;
  }

  writeTypeRef(encoder: Encoder): void {
    encoder.writeVarUint(this.kind);
    if (this.kind === TYPE_XML_ELEMENT || this.kind === TYPE_XML_HOOK) encoder.writeVarString(this.nodeName);
  }

  /** Called when the type becomes part of a document (root: item null). Applies prelim content like Yjs. */
  integrateInto(doc: Doc, item: Item | null): void {
    this.doc = doc;
    this._item = item;
    if (this.integrated) return;
    this.integrated = true;
    if (this.kind === TYPE_XML_FRAGMENT || this.kind === TYPE_XML_ELEMENT || this.kind === TYPE_ARRAY) {
      const children = this.prelimChildren;
      this.prelimChildren = [];
      if (children.length > 0) this.insert(0, children);
    }
    if (this.kind === TYPE_XML_ELEMENT || this.kind === TYPE_MAP) {
      const attrs = this.prelimAttrs;
      this.prelimAttrs = new Map<string, MapContent>();
      for (const [key, value] of attrs) this.setMapContent(key, value);
    }
    if (this.isText) {
      const pending = this.pending;
      this.pending = [];
      for (const f of pending) f();
    }
  }

  get parent(): YType | null {
    return this._item !== null ? this._item.parent : null;
  }

  /** Number of elements (list types) or text length. */
  get length(): number {
    return this.doc === null && (this.kind === TYPE_XML_FRAGMENT || this.kind === TYPE_XML_ELEMENT || this.kind === TYPE_ARRAY) ? this.prelimChildren.length : this._length;
  }

  // ------------------------------------------------ list API (Y.XmlFragment, Y.XmlElement children, Y.Array)

  insert(index: number, content: ListContent[]): void {
    const doc = this.doc;
    if (doc === null) {
      this.prelimChildren.splice(index, 0, ...content);
      return;
    }
    doc.transact((tr) => typeListInsertGenerics(tr, this, index, content));
  }

  push(content: ListContent[]): void {
    this.insert(this.length, content);
  }

  delete(index: number, length: number): void {
    const doc = this.doc;
    if (doc === null) {
      this.prelimChildren.splice(index, length);
      return;
    }
    if (this.isText) {
      if (length === 0) return;
      doc.transact((tr) => deleteText(tr, findPosition(tr, this, index), length));
      return;
    }
    doc.transact((tr) => typeListDelete(tr, this, index, length));
  }

  /** The live children (types and values) of a list type. */
  toArray(): ListContent[] {
    const out: ListContent[] = [];
    let n = this._start;
    while (n !== null) {
      if (n.countable && !n.deleted) appendContent(out, n.content);
      n = n.right;
    }
    return out;
  }

  /** The live child types (Y.XmlElement / Y.XmlText) of an XML fragment or element. */
  children(): YType[] {
    const out: YType[] = [];
    let n = this._start;
    while (n !== null) {
      if (n.countable && !n.deleted && n.content.ref === CONTENT_TYPE) out.push(n.content.type!);
      n = n.right;
    }
    return out;
  }

  // ------------------------------------------------ map API (Y.Map, Y.XmlElement attributes, Y.Text attributes)

  set(key: string, value: YValue): void {
    this.setMapContent(key, MapContent.ofValue(value));
  }

  setType(key: string, value: YType): void {
    this.setMapContent(key, MapContent.ofType(value));
  }

  /** Y.XmlElement#setAttribute */
  setAttribute(key: string, value: YValue): void {
    this.set(key, value);
  }

  private setMapContent(key: string, value: MapContent): void {
    const doc = this.doc;
    if (doc === null) {
      this.prelimAttrs.set(key, value);
      return;
    }
    doc.transact((tr) => typeMapSet(tr, this, key, value));
  }

  removeAttribute(key: string): void {
    this.deleteKey(key);
  }

  deleteKey(key: string): void {
    const doc = this.doc;
    if (doc === null) {
      this.prelimAttrs.delete(key);
      return;
    }
    doc.transact((tr) => {
      const c = this._map.get(key);
      if (c !== undefined) c.delete(tr);
    });
  }

  has(key: string): boolean {
    const v = this._map.get(key);
    return v !== undefined && !v.deleted;
  }

  /** A plain value stored under `key` (null if missing or a nested type). */
  get(key: string): YValue | null {
    const v = this._map.get(key);
    if (v === undefined || v.deleted) return null;
    return lastValue(v.content);
  }

  getAttribute(key: string): YValue | null {
    return this.get(key);
  }

  /** A nested type stored under `key`. */
  getType(key: string): YType | null {
    const v = this._map.get(key);
    if (v === undefined || v.deleted || v.content.ref !== CONTENT_TYPE) return null;
    return v.content.type;
  }

  keys(): string[] {
    const out: string[] = [];
    for (const [key, item] of this._map) if (!item.deleted) out.push(key);
    return out;
  }

  /** All attributes as an object (Y.XmlElement#getAttributes / Y.Map values; nested types as their JSON). */
  getAttributes(): YValue {
    const res = YValue.object();
    for (const [key, item] of this._map) {
      if (item.deleted) continue;
      const v = lastValue(item.content);
      if (v !== null) res.set(key, v);
      else if (item.content.ref === CONTENT_TYPE) res.set(key, item.content.type!.toJSON());
    }
    return res;
  }

  // ------------------------------------------------ text API (Y.Text, Y.XmlText)

  /** Inserts text; `attributes` null means "continue the formatting at that position". */
  insertText(index: number, text: string, attributes: YValue | null): void {
    if (text.length <= 0) return;
    const doc = this.doc;
    if (doc === null) {
      this.pending.push(() => this.insertText(index, text, attributes));
      return;
    }
    doc.transact((tr) => {
      const pos = findPosition(tr, this, index);
      let attrs = attributes;
      if (attrs === null) {
        attrs = YValue.object();
        for (const [k, v] of pos.currentAttributes) attrs.set(k, v);
      } else attrs = cloneObject(attrs);
      insertText(tr, this, pos, InsertContent.ofString(text), attrs);
    });
  }

  insertEmbed(index: number, embed: YValue, attributes: YValue | null): void {
    const doc = this.doc;
    if (doc === null) {
      this.pending.push(() => this.insertEmbed(index, embed, attributes));
      return;
    }
    doc.transact((tr) => {
      const pos = findPosition(tr, this, index);
      insertText(tr, this, pos, InsertContent.ofEmbed(embed), attributes === null ? YValue.object() : cloneObject(attributes));
    });
  }

  format(index: number, length: number, attributes: YValue): void {
    if (length === 0) return;
    const doc = this.doc;
    if (doc === null) {
      this.pending.push(() => this.format(index, length, attributes));
      return;
    }
    doc.transact((tr) => {
      const pos = findPosition(tr, this, index);
      if (pos.right === null) return;
      formatText(tr, this, pos, length, attributes);
    });
  }

  applyDelta(delta: DeltaOp[]): void {
    const doc = this.doc;
    if (doc === null) {
      this.pending.push(() => this.applyDelta(delta));
      return;
    }
    doc.transact((tr) => {
      const currPos = new TextPosition(null, this._start, 0, new Map<string, YValue>());
      for (const op of delta) {
        if (op.kind === DELTA_INSERT) {
          const ins = op.insert;
          if (ins.kind !== INSERT_STRING || ins.str.length > 0) insertText(tr, this, currPos, ins, op.attributes === null ? YValue.object() : cloneObject(op.attributes));
        } else if (op.kind === DELTA_RETAIN) {
          formatText(tr, this, currPos, op.count, op.attributes === null ? YValue.object() : op.attributes);
        } else {
          deleteText(tr, currPos, op.count);
        }
      }
    });
  }

  toDelta(): DeltaOp[] {
    const ops: DeltaOp[] = [];
    const currentAttributes = new Map<string, YValue>();
    let str = "";
    const packStr = (): void => {
      if (str.length > 0) {
        ops.push(DeltaOp.insertString(str, attributesOf(currentAttributes)));
        str = "";
      }
    };
    let n = this._start;
    while (n !== null) {
      if (!n.deleted) {
        const c = n.content;
        if (c.ref === CONTENT_STRING) str += c.str;
        else if (c.ref === CONTENT_TYPE || c.ref === CONTENT_EMBED) {
          packStr();
          const ins = c.ref === CONTENT_TYPE ? InsertContent.ofType(c.type!) : InsertContent.ofEmbed(c.value);
          ops.push(DeltaOp.insertContent(ins, attributesOf(currentAttributes)));
        } else if (c.ref === CONTENT_FORMAT) {
          packStr();
          updateCurrentAttributes(currentAttributes, c);
        }
      }
      n = n.right;
    }
    packStr();
    return ops;
  }

  toString(): string {
    if (this.isText) {
      let s = "";
      let n = this._start;
      while (n !== null) {
        if (!n.deleted && n.countable && n.content.ref === CONTENT_STRING) s += n.content.str;
        n = n.right;
      }
      return s;
    }
    return stringifyJson(this.toJSON()) ?? "";
  }

  /** Y.Map#toJSON (object), list types (array of child JSON), text (string). */
  toJSON(): YValue {
    if (this.kind === TYPE_MAP) return this.getAttributes();
    if (this.isText) return YValue.string(this.toString());
    const items: YValue[] = [];
    for (const c of this.toArray()) items.push(c instanceof YType ? c.toJSON() : c);
    return YValue.array(items);
  }
}

/** A list element: a nested type or a plain value. */
export type ListContent = YType | YValue;

function appendContent(out: ListContent[], c: Content): void {
  switch (c.ref) {
    case CONTENT_TYPE:
      out.push(c.type!);
      return;
    case CONTENT_ANY:
    case CONTENT_JSON:
      for (const v of c.arr) out.push(v);
      return;
    case CONTENT_STRING:
      for (let i = 0; i < c.str.length; i++) out.push(YValue.string(c.str.charAt(i)));
      return;
    case CONTENT_EMBED:
      out.push(c.value);
      return;
    case CONTENT_BINARY:
      out.push(YValue.bytes(c.buf));
  }
}

function lastValue(c: Content): YValue | null {
  switch (c.ref) {
    case CONTENT_ANY:
    case CONTENT_JSON:
      return c.arr[c.arr.length - 1] ?? null;
    case CONTENT_BINARY:
      return YValue.bytes(c.buf);
    case CONTENT_EMBED:
      return c.value;
    case CONTENT_STRING:
      return YValue.string(c.str.charAt(c.str.length - 1));
    default:
      return null;
  }
}

/** A value for a map key: a plain value or a nested type. */
export class MapContent {
  value: YValue = YValue.undefined();
  type: YType | null = null;

  static ofValue(value: YValue): MapContent {
    const m = new MapContent();
    m.value = value;
    return m;
  }

  static ofType(type: YType): MapContent {
    const m = new MapContent();
    m.type = type;
    return m;
  }
}

function addChangedTypeToTransaction(transaction: Transaction, type: YType): void {
  const item = type._item;
  if (item === null || (item.id.clock < (transaction.beforeState.get(item.id.client) ?? 0) && !item.deleted)) transaction.changed.add(type);
}

function nextId(tr: Transaction): ID {
  const doc = tr.doc;
  return new ID(doc.clientID, getState(doc.store, doc.clientID));
}

function typeListInsertGenericsAfter(transaction: Transaction, parent: YType, referenceItem: Item | null, content: ListContent[]): void {
  let left = referenceItem;
  const right = referenceItem === null ? parent._start : referenceItem.right;
  let jsonContent: YValue[] = [];
  const packJsonContent = (): void => {
    if (jsonContent.length > 0) {
      left = Item.create(nextId(transaction), left, left !== null ? left.lastId : null, right, right !== null ? right.id : null, parent, null, Content.any(jsonContent));
      left.integrate(transaction, 0);
      jsonContent = [];
    }
  };
  for (const c of content) {
    if (c instanceof YType) {
      packJsonContent();
      left = Item.create(nextId(transaction), left, left !== null ? left.lastId : null, right, right !== null ? right.id : null, parent, null, Content.ofType(c));
      left.integrate(transaction, 0);
    } else if (c.tag === 7) {
      packJsonContent();
      left = Item.create(nextId(transaction), left, left !== null ? left.lastId : null, right, right !== null ? right.id : null, parent, null, Content.binary(c.bytes));
      left.integrate(transaction, 0);
    } else {
      jsonContent.push(c);
    }
  }
  packJsonContent();
}

function typeListInsertGenerics(transaction: Transaction, parent: YType, index: number, content: ListContent[]): void {
  if (index > parent._length) throw new Error("Length exceeded!");
  if (index === 0) {
    typeListInsertGenericsAfter(transaction, parent, null, content);
    return;
  }
  let n = parent._start;
  for (; n !== null; n = n.right) {
    if (!n.deleted && n.countable) {
      if (index <= n.length) {
        if (index < n.length) getItemCleanStart(transaction, new ID(n.id.client, n.id.clock + index));
        break;
      }
      index -= n.length;
    }
  }
  typeListInsertGenericsAfter(transaction, parent, n, content);
}

function typeListDelete(transaction: Transaction, parent: YType, index: number, length: number): void {
  if (length === 0) return;
  let n = parent._start;
  for (; n !== null && index > 0; n = n.right) {
    if (!n.deleted && n.countable) {
      if (index < n.length) getItemCleanStart(transaction, new ID(n.id.client, n.id.clock + index));
      index -= n.length;
    }
  }
  while (length > 0 && n !== null) {
    if (!n.deleted) {
      if (length < n.length) getItemCleanStart(transaction, new ID(n.id.client, n.id.clock + length));
      n.delete(transaction);
      length -= n.length;
    }
    n = n.right;
  }
  if (length > 0) throw new Error("Length exceeded!");
}

function typeMapSet(transaction: Transaction, parent: YType, key: string, value: MapContent): void {
  const left = parent._map.get(key) ?? null;
  let content: Content;
  if (value.type !== null) content = Content.ofType(value.type);
  else if (value.value.tag === 7) content = Content.binary(value.value.bytes);
  else content = Content.any([value.value]);
  Item.create(nextId(transaction), left, left !== null ? left.lastId : null, null, null, parent, key, content).integrate(transaction, 0);
}

// ---------------------------------------------------------------- text (Y.Text formatting algorithm)

export const INSERT_STRING = 0;
export const INSERT_EMBED = 1;
export const INSERT_TYPE = 2;

export class InsertContent {
  str = "";
  embed: YValue = YValue.null();
  type: YType | null = null;
  constructor(readonly kind: number) {}

  static ofString(s: string): InsertContent {
    const c = new InsertContent(INSERT_STRING);
    c.str = s;
    return c;
  }

  static ofEmbed(v: YValue): InsertContent {
    const c = new InsertContent(INSERT_EMBED);
    c.embed = v;
    return c;
  }

  static ofType(t: YType): InsertContent {
    const c = new InsertContent(INSERT_TYPE);
    c.type = t;
    return c;
  }
}

export const DELTA_INSERT = 0;
export const DELTA_RETAIN = 1;
export const DELTA_DELETE = 2;

/** A Quill-style delta operation. */
export class DeltaOp {
  insert: InsertContent = InsertContent.ofString("");
  count = 0;
  /** An object of formatting attributes, or null. */
  attributes: YValue | null = null;
  constructor(readonly kind: number) {}

  static insertString(text: string, attributes: YValue | null): DeltaOp {
    const op = new DeltaOp(DELTA_INSERT);
    op.insert = InsertContent.ofString(text);
    op.attributes = attributes;
    return op;
  }

  static insertContent(ins: InsertContent, attributes: YValue | null): DeltaOp {
    const op = new DeltaOp(DELTA_INSERT);
    op.insert = ins;
    op.attributes = attributes;
    return op;
  }

  static retain(count: number, attributes: YValue | null): DeltaOp {
    const op = new DeltaOp(DELTA_RETAIN);
    op.count = count;
    op.attributes = attributes;
    return op;
  }

  static delete(count: number): DeltaOp {
    const op = new DeltaOp(DELTA_DELETE);
    op.count = count;
    return op;
  }
}

function attributesOf(current: Map<string, YValue>): YValue | null {
  if (current.size === 0) return null;
  const attrs = YValue.object();
  for (const [k, v] of current) attrs.set(k, v);
  return attrs;
}

function cloneObject(v: YValue): YValue {
  const o = YValue.object();
  for (let i = 0; i < v.keys.length; i++) o.set(v.keys[i]!, v.items[i]!);
  return o;
}

/** `attributes[key] ?? null` */
function attrOrNull(attributes: YValue, key: string): YValue {
  const v = attributes.get(key);
  return v === null || v.tag === T_UNDEFINED ? YValue.null() : v;
}

class TextPosition {
  constructor(
    public left: Item | null,
    public right: Item | null,
    public index: number,
    public currentAttributes: Map<string, YValue>,
  ) {}

  forward(): void {
    const right = this.right;
    if (right === null) throw new Error("Unexpected case");
    if (right.content.ref === CONTENT_FORMAT) {
      if (!right.deleted) updateCurrentAttributes(this.currentAttributes, right.content);
    } else if (!right.deleted) this.index += right.length;
    this.left = right;
    this.right = right.right;
  }
}

function updateCurrentAttributes(current: Map<string, YValue>, format: Content): void {
  if (format.value.isNull()) current.delete(format.key);
  else current.set(format.key, format.value);
}

function findNextPosition(transaction: Transaction, pos: TextPosition, count: number): TextPosition {
  while (pos.right !== null && count > 0) {
    const right = pos.right;
    if (right.content.ref === CONTENT_FORMAT) {
      if (!right.deleted) updateCurrentAttributes(pos.currentAttributes, right.content);
    } else if (!right.deleted) {
      if (count < right.length) getItemCleanStart(transaction, new ID(right.id.client, right.id.clock + count));
      pos.index += right.length;
      count -= right.length;
    }
    pos.left = pos.right;
    pos.right = pos.right!.right;
  }
  return pos;
}

function findPosition(transaction: Transaction, parent: YType, index: number): TextPosition {
  const pos = new TextPosition(null, parent._start, 0, new Map<string, YValue>());
  return findNextPosition(transaction, pos, index);
}

function insertNegatedAttributes(transaction: Transaction, parent: YType, currPos: TextPosition, negated: Map<string, YValue>): void {
  while (currPos.right !== null && (currPos.right.deleted || (currPos.right.content.ref === CONTENT_FORMAT && equalAttrs(negated.get(currPos.right.content.key) ?? YValue.undefined(), currPos.right.content.value)))) {
    if (!currPos.right.deleted) negated.delete(currPos.right.content.key);
    currPos.forward();
  }
  for (const [key, val] of negated) {
    const left = currPos.left;
    const right = currPos.right;
    const nextFormat = Item.create(nextId(transaction), left, left !== null ? left.lastId : null, right, right !== null ? right.id : null, parent, null, Content.format(key, val));
    nextFormat.integrate(transaction, 0);
    currPos.right = nextFormat;
    currPos.forward();
  }
}

function minimizeAttributeChanges(currPos: TextPosition, attributes: YValue): void {
  for (;;) {
    const right = currPos.right;
    if (right === null) break;
    if (right.deleted || (right.content.ref === CONTENT_FORMAT && equalAttrs(attrOrNull(attributes, right.content.key), right.content.value))) {
      // continue
    } else break;
    currPos.forward();
  }
}

function insertAttributes(transaction: Transaction, parent: YType, currPos: TextPosition, attributes: YValue): Map<string, YValue> {
  const negated = new Map<string, YValue>();
  for (let i = 0; i < attributes.keys.length; i++) {
    const key = attributes.keys[i]!;
    const val = attributes.items[i]!;
    const currentVal = currPos.currentAttributes.get(key) ?? YValue.null();
    if (!equalAttrs(currentVal, val)) {
      negated.set(key, currentVal);
      const left = currPos.left;
      const right = currPos.right;
      currPos.right = Item.create(nextId(transaction), left, left !== null ? left.lastId : null, right, right !== null ? right.id : null, parent, null, Content.format(key, val));
      currPos.right.integrate(transaction, 0);
      currPos.forward();
    }
  }
  return negated;
}

function insertText(transaction: Transaction, parent: YType, currPos: TextPosition, text: InsertContent, attributes: YValue): void {
  for (const key of currPos.currentAttributes.keys()) {
    const a = attributes.get(key);
    if (a === null || a.tag === T_UNDEFINED) attributes.set(key, YValue.null());
  }
  minimizeAttributeChanges(currPos, attributes);
  const negated = insertAttributes(transaction, parent, currPos, attributes);
  const content = text.kind === INSERT_STRING ? Content.string(text.str) : text.kind === INSERT_TYPE ? Content.ofType(text.type!) : Content.embed(text.embed);
  const left = currPos.left;
  const index = currPos.index;
  const right = Item.create(nextId(transaction), left, left !== null ? left.lastId : null, currPos.right, currPos.right !== null ? currPos.right.id : null, parent, null, content);
  right.integrate(transaction, 0);
  currPos.right = right;
  currPos.index = index;
  currPos.forward();
  insertNegatedAttributes(transaction, parent, currPos, negated);
}

function formatText(transaction: Transaction, parent: YType, currPos: TextPosition, length: number, attributes: YValue): void {
  minimizeAttributeChanges(currPos, attributes);
  const negated = insertAttributes(transaction, parent, currPos, attributes);
  for (;;) {
    const right = currPos.right;
    if (right === null || !(length > 0 || (negated.size > 0 && (right.deleted || right.content.ref === CONTENT_FORMAT)))) break;
    if (!right.deleted) {
      if (right.content.ref === CONTENT_FORMAT) {
        const key = right.content.key;
        const value = right.content.value;
        const attr = attributes.get(key);
        if (attr !== null && attr.tag !== T_UNDEFINED) {
          if (equalAttrs(attr, value)) negated.delete(key);
          else {
            if (length === 0) break;
            negated.set(key, value);
          }
          right.delete(transaction);
        } else currPos.currentAttributes.set(key, value);
      } else {
        if (length < right.length) getItemCleanStart(transaction, new ID(right.id.client, right.id.clock + length));
        length -= right.length;
      }
    }
    currPos.forward();
  }
  if (length > 0) {
    let newlines = "";
    for (; length > 0; length--) newlines += "\n";
    const left = currPos.left;
    const r = currPos.right;
    currPos.right = Item.create(nextId(transaction), left, left !== null ? left.lastId : null, r, r !== null ? r.id : null, parent, null, Content.string(newlines));
    currPos.right.integrate(transaction, 0);
    currPos.forward();
  }
  insertNegatedAttributes(transaction, parent, currPos, negated);
}

function cleanupFormattingGap(transaction: Transaction, start: Item, curr: Item | null, startAttributes: Map<string, YValue>, currAttributes: Map<string, YValue>): number {
  let end: Item | null = start;
  const endFormats = new Map<string, Content>();
  while (end !== null && (!end.countable || end.deleted)) {
    if (!end.deleted && end.content.ref === CONTENT_FORMAT) endFormats.set(end.content.key, end.content);
    end = end.right;
  }
  let cleanups = 0;
  let reachedCurr = false;
  let s: Item | null = start;
  while (s !== null && s !== end) {
    if (curr === s) reachedCurr = true;
    if (!s.deleted) {
      const content = s.content;
      if (content.ref === CONTENT_FORMAT) {
        const key = content.key;
        const value = content.value;
        const startAttrValue = startAttributes.get(key) ?? YValue.null();
        if (endFormats.get(key) !== content || strictEquals(startAttrValue, value)) {
          s.delete(transaction);
          cleanups++;
          if (!reachedCurr && strictEquals(currAttributes.get(key) ?? YValue.null(), value) && !strictEquals(startAttrValue, value)) {
            if (startAttrValue.isNull()) currAttributes.delete(key);
            else currAttributes.set(key, startAttrValue);
          }
        }
        if (!reachedCurr && !s.deleted) updateCurrentAttributes(currAttributes, content);
      }
    }
    s = s.right;
  }
  return cleanups;
}

function cleanupContextlessFormattingGap(transaction: Transaction, start: Item): void {
  let item: Item | null = start;
  while (item !== null && item.right !== null && (item.right.deleted || !item.right.countable)) item = item.right;
  const attrs = new Set<string>();
  while (item !== null && (item.deleted || !item.countable)) {
    if (!item.deleted && item.content.ref === CONTENT_FORMAT) {
      const key = item.content.key;
      if (attrs.has(key)) item.delete(transaction);
      else attrs.add(key);
    }
    item = item.left;
  }
}

function cleanupYTextFormatting(type: YType): void {
  type.doc!.transact((transaction) => {
    let start = type._start!;
    let end = type._start;
    let startAttributes = new Map<string, YValue>();
    const currentAttributes = new Map<string, YValue>();
    while (end !== null) {
      if (!end.deleted) {
        if (end.content.ref === CONTENT_FORMAT) updateCurrentAttributes(currentAttributes, end.content);
        else {
          cleanupFormattingGap(transaction, start, end, startAttributes, currentAttributes);
          startAttributes = new Map<string, YValue>(currentAttributes);
          start = end;
        }
      }
      end = end.right;
    }
  });
}

function cleanupYTextAfterTransaction(transaction: Transaction): void {
  const needFullCleanup = new Set<YType>();
  const doc = transaction.doc;
  for (const [client, afterClock] of transaction.afterState) {
    const clock = transaction.beforeState.get(client) ?? 0;
    if (afterClock === clock) continue;
    iterateStructs(transaction, doc.store.clients.get(client)!, clock, afterClock, (item) => {
      if (!item.deleted && item.kind === STRUCT_ITEM && item.content.ref === CONTENT_FORMAT) needFullCleanup.add(item.parent!);
    });
  }
  doc.transact((t) => {
    iterateDeletedStructs(transaction, transaction.deleteSet, (item) => {
      if (item.kind !== STRUCT_ITEM) return;
      const parent = item.parent;
      if (parent === null || !parent.hasFormatting || needFullCleanup.has(parent)) return;
      if (item.content.ref === CONTENT_FORMAT) needFullCleanup.add(parent);
      else cleanupContextlessFormattingGap(t, item);
    });
    for (const yText of needFullCleanup) cleanupYTextFormatting(yText);
  });
}

function deleteText(transaction: Transaction, currPos: TextPosition, length: number): TextPosition {
  const startAttrs = new Map<string, YValue>(currPos.currentAttributes);
  const start = currPos.right;
  while (length > 0 && currPos.right !== null) {
    const right = currPos.right;
    if (!right.deleted) {
      const ref = right.content.ref;
      if (ref === CONTENT_TYPE || ref === CONTENT_EMBED || ref === CONTENT_STRING) {
        if (length < right.length) getItemCleanStart(transaction, new ID(right.id.client, right.id.clock + length));
        length -= right.length;
        right.delete(transaction);
      }
    }
    currPos.forward();
  }
  if (start !== null) cleanupFormattingGap(transaction, start, currPos.right, startAttrs, currPos.currentAttributes);
  return currPos;
}

// ---------------------------------------------------------------- transactions

export class Transaction {
  deleteSet = new DeleteSet();
  beforeState: Map<number, number>;
  afterState = new Map<number, number>();
  /** Types changed in this transaction (only the keys matter here). */
  changed = new Set<YType>();
  _mergeStructs: Item[] = [];
  needFormattingCleanup = false;

  constructor(
    readonly doc: Doc,
    readonly origin: unknown,
    public local: boolean,
  ) {
    this.beforeState = getStateVector(doc.store);
  }
}

function tryToMergeWithLefts(structs: Item[], pos: number): number {
  let i = pos;
  while (i > 0) {
    const right = structs[i]!;
    const left = structs[i - 1]!;
    if (left.deleted === right.deleted && left.kind === right.kind && left.mergeWith(right)) {
      if (right.kind === STRUCT_ITEM && right.parentSub !== null && right.parent!._map.get(right.parentSub) === right) right.parent!._map.set(right.parentSub, left);
      i--;
      continue;
    }
    break;
  }
  const merged = pos - i;
  if (merged > 0) structs.splice(pos + 1 - merged, merged);
  return merged;
}

function tryGcDeleteSet(ds: DeleteSet, store: StructStore): void {
  for (const [client, deleteItems] of ds.clients) {
    const structs = store.clients.get(client)!;
    for (let di = deleteItems.length - 1; di >= 0; di--) {
      const deleteItem = deleteItems[di]!;
      const endDeleteItemClock = deleteItem.clock + deleteItem.len;
      for (let si = findIndexSS(structs, deleteItem.clock); si < structs.length; si++) {
        const struct = structs[si]!;
        if (struct.id.clock >= endDeleteItemClock) break;
        if (struct.kind === STRUCT_ITEM && struct.deleted && !struct.keep) struct.gc(store, false);
      }
    }
  }
}

function tryMergeDeleteSet(ds: DeleteSet, store: StructStore): void {
  for (const [client, deleteItems] of ds.clients) {
    const structs = store.clients.get(client)!;
    for (let di = deleteItems.length - 1; di >= 0; di--) {
      const deleteItem = deleteItems[di]!;
      const mostRightIndexToCheck = Math.min(structs.length - 1, 1 + findIndexSS(structs, deleteItem.clock + deleteItem.len - 1));
      for (let si = mostRightIndexToCheck; si > 0 && structs[si]!.id.clock >= deleteItem.clock; ) {
        si -= 1 + tryToMergeWithLefts(structs, si);
      }
    }
  }
}

function writeUpdateMessageFromTransaction(encoder: Encoder, transaction: Transaction): boolean {
  let changed = false;
  for (const [client, clock] of transaction.afterState) {
    if (transaction.beforeState.get(client) !== clock) changed = true;
  }
  if (transaction.deleteSet.clients.size === 0 && !changed) return false;
  sortAndMergeDeleteSet(transaction.deleteSet);
  writeClientsStructs(encoder, transaction.doc.store, transaction.beforeState);
  writeDeleteSet(encoder, transaction.deleteSet);
  return true;
}

function cleanupTransactions(cleanups: Transaction[], i: number): void {
  if (i >= cleanups.length) return;
  const transaction = cleanups[i]!;
  const doc = transaction.doc;
  const store = doc.store;
  const ds = transaction.deleteSet;
  const mergeStructs = transaction._mergeStructs;
  try {
    sortAndMergeDeleteSet(ds);
    transaction.afterState = getStateVector(store);
    // Y.Text#_callObserver: a remote change to formatted text schedules a formatting cleanup
    for (const type of transaction.changed) {
      if (type._item !== null && type._item.deleted) continue;
      if (type.isText && !transaction.local && type.hasFormatting) transaction.needFormattingCleanup = true;
    }
    if (transaction.needFormattingCleanup) cleanupYTextAfterTransaction(transaction);
  } finally {
    if (doc.gc) tryGcDeleteSet(ds, store);
    tryMergeDeleteSet(ds, store);
    for (const [client, clock] of transaction.afterState) {
      const beforeClock = transaction.beforeState.get(client) ?? 0;
      if (beforeClock !== clock) {
        const structs = store.clients.get(client)!;
        const firstChangePos = Math.max(findIndexSS(structs, beforeClock), 1);
        for (let k = structs.length - 1; k >= firstChangePos; ) k -= 1 + tryToMergeWithLefts(structs, k);
      }
    }
    for (let k = mergeStructs.length - 1; k >= 0; k--) {
      const id = mergeStructs[k]!.id;
      const structs = store.clients.get(id.client)!;
      const replacedStructPos = findIndexSS(structs, id.clock);
      if (replacedStructPos + 1 < structs.length) {
        if (tryToMergeWithLefts(structs, replacedStructPos + 1) > 1) continue;
      }
      if (replacedStructPos > 0) tryToMergeWithLefts(structs, replacedStructPos);
    }
    if (!transaction.local && transaction.afterState.get(doc.clientID) !== transaction.beforeState.get(doc.clientID)) {
      doc.clientID = generateClientId();
    }
    if (doc.updateHandlerCount() > 0) {
      const encoder = new Encoder();
      if (writeUpdateMessageFromTransaction(encoder, transaction)) doc.emitUpdate(encoder.toUint8Array(), transaction.origin);
    }
    if (cleanups.length <= i + 1) doc._transactionCleanups = [];
    else cleanupTransactions(cleanups, i + 1);
  }
}

export function generateClientId(): number {
  return Math.floor(Math.random() * 4294967296);
}

export type UpdateHandler = (update: Uint8Array, origin: unknown) => void;

export class DocOptions {
  clientID = -1;
  gc = true;
}

export class Doc {
  clientID: number;
  gc: boolean;
  share = new Map<string, YType>();
  store = new StructStore();
  _transaction: Transaction | null = null;
  _transactionCleanups: Transaction[] = [];
  private updateHandlers: UpdateHandler[] = [];

  constructor(options: DocOptions = new DocOptions()) {
    this.clientID = options.clientID >= 0 ? options.clientID : generateClientId();
    this.gc = options.gc;
  }

  static withClientId(clientID: number): Doc {
    const o = new DocOptions();
    o.clientID = clientID;
    return new Doc(o);
  }

  /** Runs `f` in a transaction (nested calls join the outer one). */
  transact(f: (tr: Transaction) => void, origin: unknown = null): void {
    transact(this, f, origin, true);
  }

  /** The root type `name`, created on first use. Converts a placeholder created by an update to `kind`. */
  get(name: string, kind: number): YType {
    let type = this.share.get(name);
    if (type === undefined) {
      type = new YType(kind);
      this.share.set(name, type);
      type.integrateInto(this, null);
      return type;
    }
    if (kind !== TYPE_ABSTRACT && type.kind !== kind) {
      if (type.kind === TYPE_ABSTRACT) type.kind = kind;
      else throw new Error("Type with the name " + name + " has already been defined with a different constructor");
    }
    return type;
  }

  getXmlFragment(name: string): YType {
    return this.get(name, TYPE_XML_FRAGMENT);
  }

  getMap(name: string): YType {
    return this.get(name, TYPE_MAP);
  }

  getText(name: string): YType {
    return this.get(name, TYPE_TEXT);
  }

  getArray(name: string): YType {
    return this.get(name, TYPE_ARRAY);
  }

  onUpdate(handler: UpdateHandler): void {
    this.updateHandlers.push(handler);
  }

  offUpdate(handler: UpdateHandler): void {
    const i = this.updateHandlers.indexOf(handler);
    if (i >= 0) this.updateHandlers.splice(i, 1);
  }

  updateHandlerCount(): number {
    return this.updateHandlers.length;
  }

  emitUpdate(update: Uint8Array, origin: unknown): void {
    for (const h of this.updateHandlers.slice()) h(update, origin);
  }

  destroy(): void {
    this.updateHandlers = [];
  }
}

export function transact(doc: Doc, f: (tr: Transaction) => void, origin: unknown, local: boolean): void {
  const cleanups = doc._transactionCleanups;
  let initialCall = false;
  let tr = doc._transaction;
  if (tr === null) {
    initialCall = true;
    tr = new Transaction(doc, origin, local);
    doc._transaction = tr;
    cleanups.push(tr);
  }
  try {
    f(tr);
  } finally {
    if (initialCall) {
      const finishCleanup = doc._transaction === cleanups[0];
      doc._transaction = null;
      if (finishCleanup) cleanupTransactions(cleanups, 0);
    }
  }
}

function findRootTypeKey(type: YType): string {
  const doc = type.doc;
  if (doc !== null) for (const [key, value] of doc.share) if (value === type) return key;
  throw new Error("Unexpected case: root type not found");
}

// ---------------------------------------------------------------- update encoding (v1)

function writeStructs(encoder: Encoder, structs: Item[], client: number, clock: number): void {
  clock = Math.max(clock, structs[0]!.id.clock);
  const start = findIndexSS(structs, clock);
  encoder.writeVarUint(structs.length - start);
  encoder.writeVarUint(client);
  encoder.writeVarUint(clock);
  const first = structs[start]!;
  first.write(encoder, clock - first.id.clock);
  for (let i = start + 1; i < structs.length; i++) structs[i]!.write(encoder, 0);
}

function writeClientsStructs(encoder: Encoder, store: StructStore, target: Map<number, number>): void {
  const sm = new Map<number, number>();
  for (const [client, clock] of target) if (getState(store, client) > clock) sm.set(client, clock);
  for (const client of getStateVector(store).keys()) if (!target.has(client)) sm.set(client, 0);
  encoder.writeVarUint(sm.size);
  for (const client of sortedClientsDesc(sm.keys())) writeStructs(encoder, store.clients.get(client)!, client, sm.get(client)!);
}

class StructRefs {
  i = 0;
  constructor(public refs: Item[]) {}
}

function readClientsStructRefs(decoder: Decoder, doc: Doc): Map<number, StructRefs> {
  const clientRefs = new Map<number, StructRefs>();
  const numOfStateUpdates = decoder.readVarUint();
  for (let i = 0; i < numOfStateUpdates; i++) {
    const numberOfStructs = decoder.readVarUint();
    const refs: Item[] = [];
    const client = decoder.readVarUint();
    let clock = decoder.readVarUint();
    clientRefs.set(client, new StructRefs(refs));
    for (let k = 0; k < numberOfStructs; k++) {
      const info = decoder.readUint8();
      const ref = info & 31;
      if (ref === 0) {
        const len = decoder.readVarUint();
        refs.push(Item.gc(new ID(client, clock), len));
        clock += len;
      } else if (ref === 10) {
        const len = decoder.readVarUint();
        refs.push(Item.skip(new ID(client, clock), len));
        clock += len;
      } else {
        const cantCopyParentInfo = (info & (64 | 128)) === 0;
        const origin = (info & 128) === 128 ? new ID(decoder.readVarUint(), decoder.readVarUint()) : null;
        const rightOrigin = (info & 64) === 64 ? new ID(decoder.readVarUint(), decoder.readVarUint()) : null;
        let parent: YType | null = null;
        let parentID: ID | null = null;
        if (cantCopyParentInfo) {
          if (decoder.readVarUint() === 1) parent = doc.get(decoder.readVarString(), TYPE_ABSTRACT);
          else parentID = new ID(decoder.readVarUint(), decoder.readVarUint());
        }
        const parentSub = cantCopyParentInfo && (info & 32) === 32 ? decoder.readVarString() : null;
        const content = readContent(decoder, info);
        const struct = new Item(STRUCT_ITEM, new ID(client, clock), content.getLength(), origin, rightOrigin, parent, parentSub, content);
        struct.parentID = parentID;
        refs.push(struct);
        clock += struct.length;
      }
    }
  }
  return clientRefs;
}

/** Integrates decoded structs; returns what could not be applied yet. */
function integrateStructs(transaction: Transaction, store: StructStore, clientsStructRefs: Map<number, StructRefs>): PendingStructs | null {
  const stack: Item[] = [];
  let ids: number[] = [];
  for (const k of clientsStructRefs.keys()) ids.push(k);
  ids.sort((a, b) => a - b);
  if (ids.length === 0) return null;
  const getNextStructTarget = (): StructRefs | null => {
    if (ids.length === 0) return null;
    let next = clientsStructRefs.get(ids[ids.length - 1]!)!;
    while (next.refs.length === next.i) {
      ids.pop();
      if (ids.length > 0) next = clientsStructRefs.get(ids[ids.length - 1]!)!;
      else return null;
    }
    return next;
  };
  let curStructsTarget = getNextStructTarget();
  if (curStructsTarget === null) return null;
  const restStructs = new PendingStructs();
  const missingSV = restStructs.missing;
  const updateMissingSv = (client: number, clock: number): void => {
    const mclock = missingSV.get(client);
    if (mclock === undefined || mclock > clock) missingSV.set(client, clock);
  };
  let stackHead: Item = curStructsTarget.refs[curStructsTarget.i++]!;
  const state = new Map<number, number>();
  const addStackToRestSS = (): void => {
    for (const item of stack) {
      const client = item.id.client;
      const inapplicable = clientsStructRefs.get(client);
      if (inapplicable !== undefined) {
        inapplicable.i--;
        restStructs.structs.set(client, inapplicable.refs.slice(inapplicable.i));
        clientsStructRefs.delete(client);
        inapplicable.i = 0;
        inapplicable.refs = [];
      } else {
        restStructs.structs.set(client, [item]);
      }
      ids = ids.filter((c) => c !== client);
    }
    stack.length = 0;
  };
  for (;;) {
    if (stackHead.kind !== STRUCT_SKIP) {
      const head = stackHead;
      let localClock = state.get(head.id.client);
      if (localClock === undefined) {
        localClock = getState(store, head.id.client);
        state.set(head.id.client, localClock);
      }
      const offset = localClock - head.id.clock;
      if (offset < 0) {
        stack.push(head);
        updateMissingSv(head.id.client, head.id.clock - 1);
        addStackToRestSS();
      } else {
        const missing = head.getMissing(transaction, store);
        if (missing !== -1) {
          stack.push(head);
          const structRefs = clientsStructRefs.get(missing) ?? new StructRefs([]);
          if (structRefs.refs.length === structRefs.i) {
            updateMissingSv(missing, getState(store, missing));
            addStackToRestSS();
          } else {
            stackHead = structRefs.refs[structRefs.i++]!;
            continue;
          }
        } else if (offset === 0 || offset < head.length) {
          head.integrate(transaction, offset);
          state.set(head.id.client, head.id.clock + head.length);
        }
      }
    }
    if (stack.length > 0) stackHead = stack.pop()!;
    else if (curStructsTarget !== null && curStructsTarget.i < curStructsTarget.refs.length) stackHead = curStructsTarget.refs[curStructsTarget.i++]!;
    else {
      curStructsTarget = getNextStructTarget();
      if (curStructsTarget === null) break;
      stackHead = curStructsTarget.refs[curStructsTarget.i++]!;
    }
  }
  return restStructs.structs.size > 0 ? restStructs : null;
}

/** A fresh, unintegrated copy of a decoded struct (pending updates are re-applied from copies, like Yjs re-decodes them). */
function cloneStruct(s: Item): Item {
  if (s.kind !== STRUCT_ITEM) return new Item(s.kind, new ID(s.id.client, s.id.clock), s.length, null, null, null, null, Content.deleted(s.length));
  const c = new Item(STRUCT_ITEM, new ID(s.id.client, s.id.clock), s.length, s.origin, s.rightOrigin, s.parent, s.parentSub, s.content.copy());
  c.parentID = s.parentID;
  return c;
}

/** The part of a decoded (unintegrated) struct from `diff` on (Yjs `sliceStruct`). */
function sliceStruct(s: Item, diff: number): Item {
  const id = new ID(s.id.client, s.id.clock + diff);
  if (s.kind !== STRUCT_ITEM) return new Item(s.kind, id, s.length - diff, null, null, null, null, Content.deleted(s.length - diff));
  const content = s.content.copy();
  const right = content.splice(diff);
  const c = new Item(STRUCT_ITEM, id, s.length - diff, new ID(s.id.client, s.id.clock + diff - 1), s.rightOrigin, s.parent, s.parentSub, right);
  c.parentID = s.parentID;
  return c;
}

/** Merges two clock-sorted struct lists of one client, dropping overlaps (Yjs mergeUpdates semantics). */
function mergeStructLists(a: Item[], b: Item[]): Item[] {
  const all = a.concat(b);
  all.sort((x, y) => (x.id.clock !== y.id.clock ? x.id.clock - y.id.clock : x.kind === STRUCT_SKIP ? 1 : y.kind === STRUCT_SKIP ? -1 : 0));
  const out: Item[] = [];
  let end = -1;
  for (const s of all) {
    const sEnd = s.id.clock + s.length;
    if (sEnd <= end) continue;
    if (s.id.clock < end) {
      if (s.kind === STRUCT_SKIP) continue;
      out.push(sliceStruct(s, end - s.id.clock));
    } else out.push(s);
    end = sEnd;
  }
  return out;
}

function applyStructsAndDeletes(transaction: Transaction, doc: Doc, ss: Map<number, StructRefs>, ds: DeleteSet): void {
  transaction.local = false;
  let retry = false;
  const store = doc.store;
  const restStructs = integrateStructs(transaction, store, ss);
  const pending = store.pendingStructs;
  if (pending !== null) {
    for (const [client, clock] of pending.missing) {
      if (clock < getState(store, client)) {
        retry = true;
        break;
      }
    }
    if (restStructs !== null) {
      for (const [client, clock] of restStructs.missing) {
        const mclock = pending.missing.get(client);
        if (mclock === undefined || mclock > clock) pending.missing.set(client, clock);
      }
      for (const [client, structs] of restStructs.structs) {
        const existing = pending.structs.get(client);
        pending.structs.set(client, existing === undefined ? structs : mergeStructLists(existing, structs));
      }
    }
  } else store.pendingStructs = restStructs;
  const dsRest = applyDeleteSet(transaction, store, ds);
  const pendingDs = store.pendingDs;
  if (pendingDs !== null) {
    const dsRest2 = applyDeleteSet(transaction, store, pendingDs);
    if (dsRest !== null && dsRest2 !== null) store.pendingDs = mergeDeleteSets([dsRest, dsRest2]);
    else store.pendingDs = dsRest !== null ? dsRest : dsRest2;
  } else store.pendingDs = dsRest;
  if (retry) {
    const p = store.pendingStructs!;
    store.pendingStructs = null;
    const refs = new Map<number, StructRefs>();
    for (const [client, structs] of p.structs) {
      const copies: Item[] = [];
      for (const s of structs) copies.push(cloneStruct(s));
      refs.set(client, new StructRefs(copies));
    }
    applyStructsAndDeletes(transaction, doc, refs, new DeleteSet());
  }
}

/** Applies a Yjs update (v1). `origin` is passed to update handlers. */
export function applyUpdate(doc: Doc, update: Uint8Array, origin: unknown = null): void {
  const decoder = new Decoder(update);
  transact(
    doc,
    (tr) => {
      const ss = readClientsStructRefs(decoder, doc);
      const ds = readDeleteSet(decoder);
      applyStructsAndDeletes(tr, doc, ss, ds);
    },
    origin,
    false,
  );
}

export function decodeStateVector(bytes: Uint8Array): Map<number, number> {
  const decoder = new Decoder(bytes);
  const ss = new Map<number, number>();
  const n = decoder.readVarUint();
  for (let i = 0; i < n; i++) {
    const client = decoder.readVarUint();
    ss.set(client, decoder.readVarUint());
  }
  return ss;
}

export function encodeStateVectorFromMap(sv: Map<number, number>): Uint8Array {
  const encoder = new Encoder();
  encoder.writeVarUint(sv.size);
  for (const client of sortedClientsDesc(sv.keys())) {
    encoder.writeVarUint(client);
    encoder.writeVarUint(sv.get(client)!);
  }
  return encoder.toUint8Array();
}

export function encodeStateVector(doc: Doc): Uint8Array {
  return encodeStateVectorFromMap(getStateVector(doc.store));
}

/**
 * The document state as one update, optionally only what a peer with `targetStateVector` is missing.
 * Pending (not yet applicable) structs and deletions are included like Yjs does.
 */
export function encodeStateAsUpdate(doc: Doc, targetStateVector: Uint8Array | null = null): Uint8Array {
  const target = targetStateVector === null ? new Map<number, number>() : decodeStateVector(targetStateVector);
  const store = doc.store;
  const encoder = new Encoder();
  const pending = store.pendingStructs;
  if (pending === null) {
    writeClientsStructs(encoder, store, target);
  } else {
    // store structs followed by pending structs (gaps filled with Skip structs)
    const lists = new Map<number, Item[]>();
    for (const [client, structs] of store.clients) lists.set(client, structs);
    for (const [client, extra] of pending.structs) {
      const base = lists.get(client);
      const merged: Item[] = base === undefined ? [] : base.slice();
      let end = merged.length > 0 ? merged[merged.length - 1]!.id.clock + merged[merged.length - 1]!.length : -1;
      for (const s of extra) {
        if (end >= 0 && s.id.clock > end) merged.push(Item.skip(new ID(client, end), s.id.clock - end));
        if (end >= 0 && s.id.clock < end) {
          if (s.id.clock + s.length <= end) continue;
          merged.push(sliceStruct(s, end - s.id.clock));
        } else merged.push(s);
        end = s.id.clock + s.length;
      }
      lists.set(client, merged);
    }
    const sm = new Map<number, number>();
    for (const [client, structs] of lists) {
      const last = structs[structs.length - 1]!;
      const state = last.id.clock + last.length;
      const clock = target.get(client) ?? 0;
      if (state > clock) sm.set(client, clock);
    }
    encoder.writeVarUint(sm.size);
    for (const client of sortedClientsDesc(sm.keys())) writeStructs(encoder, lists.get(client)!, client, sm.get(client)!);
  }
  let ds = createDeleteSetFromStructStore(store);
  if (store.pendingDs !== null) ds = mergeDeleteSets([ds, store.pendingDs]);
  writeDeleteSet(encoder, ds);
  return encoder.toUint8Array();
}

export function getDocStateVector(doc: Doc): Map<number, number> {
  return getStateVector(doc.store);
}
