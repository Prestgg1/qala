import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** A new session token: 32 random bytes, base64url (43 characters). Only the browser ever holds it. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What the database stores instead of the token: its SHA-256, hex. A leaked table cannot be replayed as cookies. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Whether `s` looks like a token `newToken` made (43 base64url characters), checked before touching the database. */
export function isToken(s: string): boolean {
  if (s.length !== 43) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95;
    if (!ok) return false;
  }
  return true;
}

/** The session's CSRF secret: HMAC-SHA256 keyed with the session token, so it changes whenever the session rotates. */
export function csrfSecret(token: string): Uint8Array {
  return new Uint8Array(createHmac("sha256", token).update("qala.csrf.v1").digest());
}

/**
 * A CSRF token for the page: a fresh random mask followed by mask XOR secret, base64url (86 characters). Masking makes
 * every token different, so a compressed response does not leak the secret (BREACH); all of them verify.
 */
export function maskToken(secret: Uint8Array): string {
  const mask = new Uint8Array(randomBytes(secret.length));
  const out = new Uint8Array(secret.length * 2);
  for (let i = 0; i < secret.length; i++) {
    out[i] = mask[i]!;
    out[secret.length + i] = mask[i]! ^ secret[i]!;
  }
  return Buffer.from(out).toString("base64url");
}

/** Whether `token` (from `maskToken`) unmasks to `secret`; constant time in the secret. */
export function verifyMaskedToken(token: string, secret: Uint8Array): boolean {
  if (token.length !== Math.ceil((secret.length * 2 * 4) / 3)) return false;
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95;
    if (!ok) return false;
  }
  const raw = new Uint8Array(Buffer.from(token, "base64url"));
  if (raw.length !== secret.length * 2) return false;
  const unmasked = new Uint8Array(secret.length);
  for (let i = 0; i < secret.length; i++) unmasked[i] = raw[i]! ^ raw[secret.length + i]!;
  return timingSafeEqual(unmasked, secret);
}

/** Constant-time string comparison (different lengths are unequal; the length itself is not secret). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}
