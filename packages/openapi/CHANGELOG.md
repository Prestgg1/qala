# @qala/openapi

## 1.0.0

### Minor Changes

- fea7614: New `@qala/openapi` package and `qala openapi [--out file] [--yaml]`: an OpenAPI 3.1 document from the app's routes, input schemas, auth and `resource()` models. `"qala": { "openapi": { "serve": true } }` in package.json makes `qala generate` write `.qala/openapi.json` and serve it at `GET /openapi.json` (natively too). Core schemas now keep their declared rules (`SchemaNode.rules`) and `resource()` controllers their model (`ControllerDef.resource`) for documentation.

### Patch Changes

- Updated dependencies [efaeba0]
- Updated dependencies [d502e84]
- Updated dependencies [564e9da]
- Updated dependencies [265c322]
- Updated dependencies [1fa3ef7]
- Updated dependencies [fea7614]
- Updated dependencies [05c8c01]
  - @qala/core@1.0.0
