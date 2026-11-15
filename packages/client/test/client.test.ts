import { describe, expect, test } from "bun:test";
import { ApiError, buildUrl, createClient } from "@qala/client";
import { type Api, inProcess, manifest } from "./fixture";

function setup() {
  const { transport, seen } = inProcess();
  const api = createClient<Api>({ baseUrl: "http://test/", manifest, transport, headers: () => ({ authorization: "Bearer x" }) });
  return { api, seen };
}

describe("createClient", () => {
  test("creates, reads and lists with typed results", async () => {
    const { api, seen } = setup();
    const made = await api.tasks.store({ body: { title: "yaz" } });
    expect(made).toEqual({ id: "1", title: "yaz", done: false, createdAt: "2026-01-02T03:04:05.000Z" });
    expect(await api.tasks.show({ params: { id: made.id } })).toEqual(made);
    expect(await api.tasks.index()).toEqual([made]);
    expect(await api.tasks.index({ query: { done: true } })).toEqual([]);
    expect(seen).toEqual(["POST /tasks", "GET /tasks/1", "GET /tasks", "GET /tasks?done=true"]);
  });

  test("custom routes and path params", async () => {
    const { api, seen } = setup();
    await api.tasks.store({ body: { title: "a" } });
    const done = await api.tasks.complete({ params: { id: "1" } });
    expect(done.done).toBe(true);
    expect(await api.tasks.echo({ params: { name: "ali veli/x" }, query: { tags: "a&b" } })).toEqual({ name: "ali veli/x", tags: "a&b" });
    expect(seen[2]).toBe("GET /tasks/echo/ali%20veli%2Fx?tags=a%26b");
  });

  test("204 and empty results resolve null", async () => {
    const { api } = setup();
    await api.tasks.store({ body: { title: "a" } });
    expect(await api.tasks.destroy({ params: { id: "1" } })).toBeNull();
    expect(await api.tasks.silent()).toBeNull();
  });

  test("non-2xx rejects with ApiError", async () => {
    const { api } = setup();
    const missing = await api.tasks.show({ params: { id: "9" } }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(ApiError);
    expect(missing).toMatchObject({ status: 404, code: "not_found", message: "Task not found" });
    const invalid = (await api.tasks.store({ body: { title: "" } }).catch((e: unknown) => e)) as ApiError;
    expect(invalid.status).toBe(422);
    expect(invalid.code).toBe("validation_failed");
    expect(invalid.details).toEqual([{ path: "title", message: "must be at least 1 characters" }]);
  });

  test("sends JSON body, base and per-call headers", async () => {
    let captured: Record<string, string> = {};
    const api = createClient<Api>({
      baseUrl: "http://x",
      manifest,
      headers: { authorization: "Bearer a" },
      transport: async (req) => {
        captured = req.headers;
        return { status: 201, body: JSON.stringify({ id: "1", title: req.body, done: false, createdAt: "" }) };
      },
    });
    const res = await api.tasks.store({ body: { title: "t" } }, { headers: { "x-trace": "1" } });
    expect(res.title).toBe('{"title":"t"}');
    expect(captured).toEqual({ accept: "application/json", authorization: "Bearer a", "content-type": "application/json", "x-trace": "1" });
  });
});

describe("buildUrl", () => {
  test("fills params, skips undefined query values, repeats arrays", () => {
    expect(buildUrl("http://h/", "/a/:id/b/:x", { id: 1, x: "é" }, { p: undefined, q: [1, 2], r: false })).toBe("http://h/a/1/b/%C3%A9?q=1&q=2&r=false");
  });
  test("throws on a missing path parameter", () => {
    expect(() => buildUrl("http://h", "/a/:id", {}, undefined)).toThrow("Missing path parameter :id");
  });
});
