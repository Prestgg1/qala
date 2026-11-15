import { defineConfig } from "@qala/core";

/** Every setting the app reads, typed and validated at startup (from the environment and .env). */
export const config = defineConfig((env) => ({
  port: env.number("PORT", 3000),
  databaseUrl: env.string("DATABASE_URL", "postgres://qala:qala@localhost:5432/qala_example"),
  apiToken: env.string("API_TOKEN", "dev-token"),
  logLevel: env.oneOf("LOG_LEVEL", ["debug", "info", "warn", "error"] as const, "info"),
  logFormat: env.oneOf("LOG_FORMAT", ["pretty", "json"] as const, "pretty"),
  logRequests: env.boolean("LOG_REQUESTS", true),
}));
