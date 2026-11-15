import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateEnv, ENV_GEN } from "./env";
import { CliError, LAYOUT } from "./util";

/**
 * The app's database URL for CLI commands (migrate, migrate:make, db:pull): `config.databaseUrl` from
 * config/app.ts, else `env.DATABASE_URL` from the typed env generated from .env.example.
 * Both read the real environment and `.env` from the app's root.
 */
export async function appDatabaseUrl(root: string): Promise<string> {
  const previous = process.cwd();
  process.chdir(root); // defineConfig reads .env from the working directory
  try {
    const configFile = join(root, LAYOUT.config);
    if (existsSync(configFile)) {
      const { config } = (await import(pathToFileURL(configFile).href)) as { config?: { databaseUrl?: string } };
      if (config !== undefined && typeof config.databaseUrl === "string") return config.databaseUrl;
    }
    if (existsSync(join(root, ".env.example"))) {
      generateEnv(root);
      const { env } = (await import(pathToFileURL(join(root, LAYOUT.generated, ENV_GEN)).href)) as { env?: { DATABASE_URL?: string } };
      if (env !== undefined && typeof env.DATABASE_URL === "string") return env.DATABASE_URL;
    }
    throw new CliError("No database URL: declare DATABASE_URL in .env.example, or export `config` with `databaseUrl` from config/app.ts (or pass --url)");
  } finally {
    process.chdir(previous);
  }
}
