---
"@qala/session": minor
---

New package `@qala/session`: server-side sessions stored in PostgreSQL (hashed tokens, `__Host-` cookie, idle and absolute expiry, rotation on login, log out everywhere, cleanup) and `csrf()` middleware (session-bound token in `x-csrf-token` / `_csrf`, Origin and Sec-Fetch-Site checks, bearer requests exempt). Works in scriptc native binaries.
