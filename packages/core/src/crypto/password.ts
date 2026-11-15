/**
 * Password hashing with Argon2id, stored as PHC strings (`$argon2id$v=19$m=65536,t=2,p=1$<salt>$<hash>`), the same
 * format `Bun.password` writes and reads, so existing hashes keep verifying.
 *
 * Under Bun this is `Bun.password` (C). In a scriptc native binary it is libsodium's `crypto_pwhash` through a tiny C
 * shim (packages/core/native/password.c) that `qala build` compiles and links when the app uses these functions; this
 * needs `cc` and libsodium (`libsodium-dev` / `libsodium`) on the build host and `libsodium.so` where the binary runs.
 * Both calls block the thread for the duration of the hash (~65 ms at the defaults).
 */

type BunPassword = {
  hash(password: string, options: { algorithm: "argon2id"; memoryCost: number; timeCost: number }): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
};
type BunLike = { password: BunPassword };
declare const Bun: BunLike | undefined;

// Signature-only declarations: scriptc binds direct calls to the C symbols in native/password.ffi.json.
declare function qalaPasswordVerify(phc: Uint8Array, password: Uint8Array): boolean;
declare function qalaPasswordHash(out: Uint8Array, password: Uint8Array, passes: number, memoryKiB: number): number;

export type PasswordOptions = {
  /** Memory cost in KiB (default 65536 = 64 MiB). */
  memoryKiB?: number;
  /** Number of passes over the memory (default 2). Parallelism is always 1. */
  passes?: number;
};

const NATIVE_HINT = "native Argon2id is not linked: build with `qala build` (needs cc and libsodium) or pass --ffi packages/core/native/password.ffi.json";

/** Hashes `password` with Argon2id and a random 16-byte salt; returns the PHC string. */
export async function hashPassword(password: string, options: PasswordOptions = {}): Promise<string> {
  if (password.length === 0) throw new RangeError("password must not be empty");
  const memoryKiB = options.memoryKiB ?? 65536;
  const passes = options.passes ?? 2;
  if (!Number.isInteger(memoryKiB) || memoryKiB < 8 || memoryKiB > 4194304) throw new RangeError("memoryKiB must be an integer between 8 and 4194304");
  if (!Number.isInteger(passes) || passes < 1 || passes > 1000) throw new RangeError("passes must be an integer between 1 and 1000");
  if (typeof Bun !== "undefined") {
    return Bun.password.hash(password, { algorithm: "argon2id", memoryCost: memoryKiB, timeCost: passes });
  }
  const out = new Uint8Array(128);
  let length = -1;
  try {
    length = qalaPasswordHash(out, new TextEncoder().encode(password), passes, memoryKiB);
  } catch (error) {
    if (error instanceof ReferenceError) throw new Error(NATIVE_HINT);
    throw error;
  }
  if (length <= 0) throw new Error("Argon2id hashing failed (out of memory?)");
  return new TextDecoder().decode(out.subarray(0, length));
}

/** True when `password` matches the Argon2id PHC string `phc`. Malformed or unsupported hashes return false. */
export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  if (password.length === 0 || !phc.startsWith("$argon2id$")) return false;
  if (typeof Bun !== "undefined") {
    try {
      return await Bun.password.verify(password, phc);
    } catch {
      return false;
    }
  }
  const encoded = new TextEncoder().encode(phc);
  if (encoded.length >= 128) return false;
  try {
    return qalaPasswordVerify(encoded, new TextEncoder().encode(password));
  } catch (error) {
    if (error instanceof ReferenceError) throw new Error(NATIVE_HINT);
    throw error;
  }
}
