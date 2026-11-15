/**
 * The y-protocols sync protocol (y-websocket wire format): step 1 (state vector), step 2 (missing update),
 * update.
 */
import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector } from "./doc";
import { Decoder, Encoder } from "./encoding";

export const MESSAGE_SYNC_STEP1 = 0;
export const MESSAGE_SYNC_STEP2 = 1;
export const MESSAGE_UPDATE = 2;

export function writeSyncStep1(encoder: Encoder, doc: Doc): void {
  encoder.writeVarUint(MESSAGE_SYNC_STEP1);
  encoder.writeVarUint8Array(encodeStateVector(doc));
}

export function writeSyncStep2(encoder: Encoder, doc: Doc, encodedStateVector: Uint8Array | null): void {
  encoder.writeVarUint(MESSAGE_SYNC_STEP2);
  encoder.writeVarUint8Array(encodeStateAsUpdate(doc, encodedStateVector));
}

export function readSyncStep1(decoder: Decoder, encoder: Encoder, doc: Doc): void {
  writeSyncStep2(encoder, doc, decoder.readVarUint8Array());
}

export function readSyncStep2(decoder: Decoder, doc: Doc, origin: unknown): void {
  applyUpdate(doc, decoder.readVarUint8Array(), origin);
}

export function writeUpdate(encoder: Encoder, update: Uint8Array): void {
  encoder.writeVarUint(MESSAGE_UPDATE);
  encoder.writeVarUint8Array(update);
}

export function readUpdate(decoder: Decoder, doc: Doc, origin: unknown): void {
  readSyncStep2(decoder, doc, origin);
}

/** Reads one sync message; a step 1 writes the reply (step 2) into `encoder`. Returns the message type. */
export function readSyncMessage(decoder: Decoder, encoder: Encoder, doc: Doc, origin: unknown): number {
  const messageType = decoder.readVarUint();
  if (messageType === MESSAGE_SYNC_STEP1) readSyncStep1(decoder, encoder, doc);
  else if (messageType === MESSAGE_SYNC_STEP2) readSyncStep2(decoder, doc, origin);
  else if (messageType === MESSAGE_UPDATE) readUpdate(decoder, doc, origin);
  else throw new Error("Unknown message type");
  return messageType;
}
