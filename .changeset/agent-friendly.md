---
"@qala/cli": minor
"@qala/core": patch
---

Agent-friendly projects: `qala new` writes `AGENTS.md` and `CLAUDE.md`; `qala check --json`, `qala routes --json` and `qala doctor --json` print stable, versioned JSON; `qala check` diagnostics have stable codes (`QALA101`…`QALA207`) with a fix hint and docs link; a failed native build explains the usual causes; common runtime errors (missing provider, missing env variables, missing `authenticate`, bad `resource()` option) name the file and the fix.
