/*
 * Native Argon2id for scriptc builds (`qala build` compiles this and links libsodium, see packages/cli/src/native.ts).
 * Bound by native/password.ffi.json; the TypeScript side is src/crypto/password.ts.
 */
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sodium.h>

int qala_pwhash_verify(const uint8_t *phc, size_t phc_len, const uint8_t *pw, size_t pw_len) {
  char buf[crypto_pwhash_STRBYTES];
  if (sodium_init() < 0 || phc_len >= sizeof buf) return 0;
  memset(buf, 0, sizeof buf);
  memcpy(buf, phc, phc_len);
  return crypto_pwhash_str_verify(buf, (const char *)pw, pw_len) == 0;
}

int32_t qala_pwhash_hash(uint8_t *out, size_t out_len, const uint8_t *pw, size_t pw_len, uint32_t passes, uint32_t memory_kib) {
  char buf[crypto_pwhash_STRBYTES];
  if (sodium_init() < 0 || out_len < sizeof buf) return -1;
  if (crypto_pwhash_str_alg(buf, (const char *)pw, pw_len, passes, (size_t)memory_kib * 1024, crypto_pwhash_ALG_ARGON2ID13) != 0) return -1;
  size_t n = strlen(buf);
  memcpy(out, buf, n);
  return (int32_t)n;
}
