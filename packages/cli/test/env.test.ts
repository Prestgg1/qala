import { describe, expect, test } from "bun:test";
import { parseEnvExample, renderEnv } from "../src/env";

const EXAMPLE = `# app
PORT=3000 # type: number
DEBUG=false # type: boolean
DATABASE_URL=postgres://localhost/app # type: url required
LOG_LEVEL=info # type: enum(debug,info,warn)
API_TOKEN=
NAME="a # b"
`;

describe("env", () => {
  test("parses types, defaults and required", () => {
    const e = parseEnvExample(EXAMPLE);
    expect(e.map((x) => [x.key, x.type, x.fallback, x.required])).toEqual([
      ["PORT", "number", "3000", false],
      ["DEBUG", "boolean", "false", false],
      ["DATABASE_URL", "url", undefined, true],
      ["LOG_LEVEL", "enum", "info", false],
      ["API_TOKEN", "string", undefined, true],
      ["NAME", "string", "a # b", false],
    ]);
  });

  test("renders a defineConfig call", () => {
    expect(renderEnv(parseEnvExample(EXAMPLE))).toContain(`  PORT: e.number("PORT", 3000),
  DEBUG: e.boolean("DEBUG", false),
  DATABASE_URL: e.url("DATABASE_URL"),
  LOG_LEVEL: e.oneOf("LOG_LEVEL", ["debug", "info", "warn"] as const, "info"),
  API_TOKEN: e.string("API_TOKEN"),`);
  });

  test("rejects bad defaults and types", () => {
    expect(() => parseEnvExample("A=x # type: number")).toThrow("not a number");
    expect(() => parseEnvExample("A=x # type: enum(a,b)")).toThrow("not one of");
    expect(() => parseEnvExample("A=x # type: date")).toThrow("unknown type");
  });
});
