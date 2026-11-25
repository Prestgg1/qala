/**
 * Loads a generated Qala app (`.qala/app.gen.ts`) on Bun and builds its OpenAPI document. Generation time
 * only: it imports the app's modules (nothing listens and the database is not contacted).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppOptions } from "@qala/core";
import { buildOpenApi, type JsonObject, type OpenApiOptions } from "./index";

/** `"qala": { "openapi": ... }` in the app's package.json. */
export type OpenApiConfig = OpenApiOptions & {
  /** Serve the document at `/openapi.json` from the app (also from the native binary). */
  serve?: boolean;
};

type PackageJson = { name?: string; version?: string; description?: string; qala?: { openapi?: boolean | OpenApiConfig } };

function readPackage(root: string): PackageJson {
  const file = join(root, "package.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as PackageJson) : {};
}

/** The app's OpenAPI settings: null when package.json does not opt in (`"qala": { "openapi": true | {...} }`). */
export function openApiConfig(root: string): OpenApiConfig | null {
  const value = readPackage(root).qala?.openapi;
  if (value === undefined || value === false) return null;
  return value === true ? {} : value;
}

/** Options for `buildOpenApi`: package.json's name/version/description, overridden by its `qala.openapi`. */
export function optionsFor(root: string): OpenApiOptions {
  const pkg = readPackage(root);
  const config = openApiConfig(root) ?? {};
  const options: OpenApiOptions = {};
  if (pkg.name !== undefined) options.title = pkg.name;
  if (pkg.version !== undefined) options.version = pkg.version;
  if (pkg.description !== undefined) options.description = pkg.description;
  const { serve: _serve, ...rest } = config;
  return { ...options, ...rest };
}

/** Imports the app from `root/.qala/app.gen.ts` (run `qala generate` first) and builds its document. */
export async function generateOpenApi(root: string, options: OpenApiOptions = optionsFor(root)): Promise<JsonObject> {
  const gen = join(root, ".qala/app.gen.ts");
  if (!existsSync(gen)) throw new Error(`${gen} is missing: run qala generate first`);
  const mod = (await import(gen)) as { appOptions: AppOptions };
  // The app's own @qala/core, so its classes are the ones the controllers were built with.
  const core = (await import(Bun.resolveSync("@qala/core", root))) as typeof import("@qala/core");
  const app = core.createApp(mod.appOptions);
  return buildOpenApi(app, mod.appOptions.controllers, options);
}
