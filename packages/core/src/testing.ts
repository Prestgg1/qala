/**
 * Test helpers (Bun only; not part of the native binary).
 *
 *   import { testApp, withRollback } from "@qala/core/testing";
 *   import { controllers } from "../.qala/routes.gen";
 *   import { manifest, type Api } from "../.qala/api";
 *
 *   const { client } = testApp<Api>({ controllers, manifest, providers });
 *
 * In an app, `.qala/app.gen.ts` has the options the real entry point uses (`qala make:test` writes this):
 *
 *   import { appOptions, setup } from "../.qala/app.gen";
 *   const { client } = testApp<Api>({ ...appOptions, manifest, setup });
 *   const task = await client.tasks.show({ params: { id } });
 */
import { createClient, type Client, type Manifest } from "@qala/client";
import type { Database, Transaction } from "./db/database";
import { createApp, type App, type AppOptions } from "./http/app";
import { RequestData } from "./http/context";

export type TestAppOptions = AppOptions & {
  /** `manifest` from `.qala/api.ts`. Defaults to the one derived from the controllers. */
  manifest?: Manifest;
  /** Headers sent with every request, e.g. `{ authorization: "Bearer test" }`. */
  headers?: Record<string, string>;
  /** Runs on the app after it is built, e.g. `setup` from `.qala/app.gen.ts` (binds model events). */
  setup?: (app: App) => void;
};

export type TestApp<Api> = {
  app: App;
  /** The typed client; requests go straight to `app.handle` (no socket). */
  client: Client<Api>;
  /** Resolves a service from the app's container, e.g. `get(TaskService)`. */
  get: App["container"]["get"];
};

/** Builds the app in-process (controllers, providers, middleware like the generated main) and returns a typed client for it. */
export function testApp<Api = never>(options: TestAppOptions): TestApp<Api> {
  const app = createApp(options);
  options.setup?.(app);
  const client = createClient<Api>({
    baseUrl: "http://test",
    manifest: options.manifest ?? app.manifest(),
    headers: options.headers,
    transport: async (req) => {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      for (const key of Object.keys(req.headers)) headers[key.toLowerCase()] = req.headers[key]!;
      const reply = await app.handle(new RequestData(req.method, url.pathname + url.search, headers, req.body, "127.0.0.1"));
      return { status: reply.status, body: reply.body };
    },
  });
  return { app, client, get: (token) => app.container.get(token) };
}

class Rollback extends Error {}

/**
 * Runs `fn` inside a transaction that is always rolled back, so a test leaves the database untouched.
 * Returns what `fn` returns; errors thrown by `fn` propagate (after the rollback).
 *
 *   test("creates", () => withRollback(db, async (tx) => {
 *     await tx.table(Task).insert({ title: "x" });
 *     expect(await tx.table(Task).all()).toHaveLength(1);
 *   }));
 */
export async function withRollback<T>(db: Database, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  let result: T | undefined;
  try {
    await db.transaction(async (tx) => {
      result = await fn(tx);
      throw new Rollback("rollback");
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return result as T;
}
