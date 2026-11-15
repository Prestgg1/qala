import { existsSync, readFileSync } from "node:fs";

/**
 * Typed environment access. Reads `process.env`, after loading `.env` from the working directory
 * (values already in the environment win). Missing required values fail at startup, all at once.
 *
 *   export const config = defineConfig((env) => ({
 *     port: env.number("PORT", 3000),
 *     database: env.string("DATABASE_URL"),
 *     debug: env.boolean("DEBUG", false),
 *   }));
 */
export class Env {
  private readonly missing: string[] = [];

  constructor(private readonly source: Record<string, string>) {}

  string(name: string, fallback?: string): string {
    const v = this.source[name];
    if (v !== undefined && v !== "") return v;
    if (fallback !== undefined) return fallback;
    this.missing.push(name);
    return "";
  }

  number(name: string, fallback?: number): number {
    const v = this.source[name];
    if (v !== undefined && v !== "") {
      const n = Number(v);
      if (!Number.isNaN(n)) return n;
      this.missing.push(`${name} (not a number: ${v})`);
      return 0;
    }
    if (fallback !== undefined) return fallback;
    this.missing.push(name);
    return 0;
  }

  boolean(name: string, fallback?: boolean): boolean {
    const v = this.source[name];
    if (v !== undefined && v !== "") return v === "true" || v === "1" || v === "yes";
    if (fallback !== undefined) return fallback;
    this.missing.push(name);
    return false;
  }

  /** A string that looks like a URL (`scheme://...`). */
  url(name: string, fallback?: string): string {
    const v = this.string(name, fallback);
    if (v === "" || /^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/.test(v)) return v;
    this.missing.push(`${name} (not a URL: ${v})`);
    return "";
  }

  oneOf<const V extends readonly string[]>(name: string, values: V, fallback?: V[number]): V[number] {
    const v = this.string(name, fallback);
    for (const allowed of values) if (allowed === v) return allowed;
    this.missing.push(`${name} (one of ${values.join(", ")})`);
    return values[0]!;
  }

  assert(): void {
    if (this.missing.length > 0) throw new Error(`Missing or invalid environment variables: ${this.missing.join(", ")}`);
  }
}

/** Parses `.env` text: `KEY=value`, `# comments`, optional quotes. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/** The environment: `.env` (if present) overlaid by real environment variables. */
export function loadEnv(file = ".env"): Record<string, string> {
  const out: Record<string, string> = existsSync(file) ? parseDotenv(readFileSync(file, "utf8")) : {};
  const env = process.env;
  for (const key of Object.keys(env)) {
    const v = env[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

export function defineConfig<C>(build: (env: Env) => C): C {
  const env = new Env(loadEnv());
  const config = build(env);
  env.assert();
  return config;
}
