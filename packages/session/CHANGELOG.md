# @qala/session

## 1.0.0

### Minor Changes

- f719028: New package `@qala/session`: server-side sessions stored in PostgreSQL (hashed tokens, `__Host-` cookie, idle and absolute expiry, rotation on login, log out everywhere, cleanup) and `csrf()` middleware (session-bound token in `x-csrf-token` / `_csrf`, Origin and Sec-Fetch-Site checks, bearer requests exempt). Works in scriptc native binaries.

### Patch Changes

- Updated dependencies [efaeba0]
- Updated dependencies [d502e84]
- Updated dependencies [564e9da]
- Updated dependencies [265c322]
- Updated dependencies [1fa3ef7]
- Updated dependencies [fea7614]
- Updated dependencies [05c8c01]
  - @qala/core@1.0.0
