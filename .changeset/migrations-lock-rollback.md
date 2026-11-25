---
"@qala/core": minor
"@qala/cli": minor
---

Production-safe migrations: `migrate()` and `qala migrate` hold a PostgreSQL advisory lock on one connection for the whole run, so concurrent deploys take turns. Down migrations (`-- migrate:down` section in the same file) with `rollback()` / `qala migrate:rollback [--steps N]`, `migrationStatus()` / `qala migrate:status`, `lockTimeout` / `statementTimeout` options (`--lock-timeout`, `--statement-timeout`), and `db.session()` to pin a connection. `migrate:make` and `make:migration` scaffold a down section.
