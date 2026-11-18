# Config and typed environment

## `.env.example` is the schema

Declare your environment once, in `.env.example`:

```sh
PORT=3000 # type: number
DEBUG=false # type: boolean
SITE_URL=http://localhost:3000 # type: url
LOG_LEVEL=info # type: enum(debug,info,warn,error)
DATABASE_URL= # type: url required  (TLS: append ?sslmode=verify-full&sslrootcert=/path/ca.pem, see Deployment)
API_TOKEN=dev-token
```

Line format: `KEY=default # type: number|boolean|string|url|enum(a,b) required`. No type comment means `string`. An empty default, or the word `required`, makes the variable required (no fallback). A default that does not fit its type fails `qala generate`.

`qala generate` writes `.qala/env.gen.ts`:

```ts
export const env = defineConfig((e) => ({
  PORT: e.number("PORT", 3000),
  DEBUG: e.boolean("DEBUG", false),
  SITE_URL: e.url("SITE_URL", "http://localhost:3000"),
  LOG_LEVEL: e.oneOf("LOG_LEVEL", ["debug", "info", "warn", "error"] as const, "info"),
  DATABASE_URL: e.url("DATABASE_URL"),
  API_TOKEN: e.string("API_TOKEN", "dev-token"),
}));
```

`env.PORT` is a `number`, `env.LOG_LEVEL` is `"debug" | "info" | "warn" | "error"`. Values come from the real environment, then `.env`. Validation runs at startup and reports every problem at once:

```
Missing or invalid environment variables: DATABASE_URL, SITE_URL (not a URL: nope)
```

## `config/app.ts`

Re-export it, or shape it:

```ts
import { env } from "../.qala/env.gen";

export const config = { port: env.PORT, databaseUrl: env.DATABASE_URL, logLevel: env.LOG_LEVEL };
```

Without a `.env.example`, `defineConfig((env) => ({ port: env.number("PORT", 3000) }))` keeps working; `Env` also has `string`, `boolean`, `oneOf` and `url`. Everything compiles with scriptc.
