---
"@qala/core": minor
---

PostgreSQL TLS: `sslmode` (`disable`, `prefer` default, `require`, `verify-ca`, `verify-full`) and `sslrootcert` in `DATABASE_URL`, in the native binary too. Existing URLs now use TLS when the server offers it; add `?sslmode=disable` to keep plain connections.
