---
"@qala/openapi": minor
"@qala/cli": minor
"@qala/core": minor
---

New `@qala/openapi` package and `qala openapi [--out file] [--yaml]`: an OpenAPI 3.1 document from the app's routes, input schemas, auth and `resource()` models. `"qala": { "openapi": { "serve": true } }` in package.json makes `qala generate` write `.qala/openapi.json` and serve it at `GET /openapi.json` (natively too). Core schemas now keep their declared rules (`SchemaNode.rules`) and `resource()` controllers their model (`ControllerDef.resource`) for documentation.
