import { describe, expect, test } from "bun:test";
import { action, controller, createApp, parseCookies, parseMultipart, post, get, RequestData, serializeCookie, serve, t, type Reply } from "@qala/core";

const PNG = new Uint8Array(300);
PNG.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
for (let i = 8; i < PNG.length; i++) PNG[i] = i % 256;
// Bytes that look like a delimiter and CRLFs must survive.
PNG.set(new TextEncoder().encode("\r\n--zzz\r\n\r\n"), 100);

const enc = new TextEncoder();
function cat(parts: (string | Uint8Array)[]): Uint8Array {
  const bufs = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p));
  const out = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of bufs) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}
function field(boundary: string, name: string, value: string): string {
  return `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
}
function file(boundary: string, name: string, filename: string, type: string, data: Uint8Array): (string | Uint8Array)[] {
  return [`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`, data, "\r\n"];
}

const Upload = controller({}, () => ({
  store: action({ body: t.object({ title: t.string(), count: t.optional(t.integer()) }), files: true }, ({ body, files }) => ({
    title: body.title,
    count: body.count ?? 0,
    files: files.map((f) => ({ field: f.field, filename: f.filename, type: f.contentType, size: f.size, bytes: Array.from(f.data) })),
  })),
  small: post("/small", { files: { maxFileSize: 10 } }, ({ files }) => ({ n: files.length })),
  plain: post("/plain", { body: t.object({ a: t.string() }) }, ({ body }) => ({ a: body.a })),
  cookies: get("/cookies", {}, ({ ctx }) => {
    ctx.setCookie("sid", "a b;c", { httpOnly: true, secure: true, sameSite: "lax", path: "/app", maxAge: 60 });
    ctx.setCookie("theme", "dark");
    ctx.clearCookie("old", { path: "/x" });
    return { sid: ctx.cookie("sid") ?? null, missing: ctx.cookie("nope") ?? null };
  }),
}));

function makeApp() {
  return createApp({ controllers: [{ name: "up", prefix: "/up", controller: Upload }] });
}
async function send(app: ReturnType<typeof makeApp>, url: string, headers: Record<string, string>, raw: Uint8Array, method = "POST"): Promise<Reply> {
  return app.handle(new RequestData(method, url, headers, "", "127.0.0.1", raw));
}

describe("multipart parser", () => {
  test("text fields and a binary file", () => {
    const b = "----QalaBoundary123";
    const body = cat([field(b, "title", "salam dünya"), ...file(b, "avatar", "x.png", "image/png", PNG), `--${b}--\r\n`]);
    const form = parseMultipart(`multipart/form-data; boundary=${b}`, body);
    expect(form.fields).toEqual({ title: "salam dünya" });
    expect(form.files.length).toBe(1);
    const f = form.files[0]!;
    expect([f.field, f.filename, f.contentType, f.size]).toEqual(["avatar", "x.png", "image/png", PNG.length]);
    expect(Buffer.from(f.data).equals(Buffer.from(PNG))).toBe(true);
  });

  test("two files, quoted boundary, empty file", () => {
    const b = "abc";
    const body = cat([...file(b, "a", "a.bin", "application/octet-stream", PNG), ...file(b, "b", "b.txt", "text/plain", enc.encode("hello")), ...file(b, "c", "c.txt", "text/plain", new Uint8Array(0)), `--${b}--`]);
    const form = parseMultipart('multipart/form-data; charset=utf-8; boundary="abc"', body);
    expect(form.files.map((f) => [f.field, f.filename, f.size])).toEqual([["a", "a.bin", PNG.length], ["b", "b.txt", 5], ["c", "c.txt", 0]]);
    expect(form.files[1]!.text()).toBe("hello");
  });

  test("bad input", () => {
    expect(() => parseMultipart("multipart/form-data", enc.encode("x"))).toThrow(/boundary/);
    expect(() => parseMultipart("multipart/form-data; boundary=zzz", enc.encode("nothing here"))).toThrow(/boundary/);
    expect(() => parseMultipart("multipart/form-data; boundary=abc", enc.encode("--abc\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\nvalue"))).toThrow(/terminated/);
    expect(() => parseMultipart("application/json", enc.encode("{}"))).toThrow();
  });

  test("per-file size limit", () => {
    const b = "abc";
    const body = cat([...file(b, "a", "a.bin", "x/y", PNG), `--${b}--`]);
    expect(() => parseMultipart("multipart/form-data; boundary=abc", body, { maxFileSize: 10, maxFiles: 0 })).toThrow(/larger/);
  });
});

describe("multipart actions", () => {
  const b = "XyZ";
  const type = { "content-type": `multipart/form-data; boundary=${b}` };

  test("fields are validated (coerced) and files delivered", async () => {
    const body = cat([field(b, "title", "hi"), field(b, "count", "3"), ...file(b, "photo", "p.png", "image/png", PNG), ...file(b, "doc", "d.txt", "text/plain", enc.encode("t")), `--${b}--\r\n`]);
    const reply = await send(makeApp(), "/up", type, body);
    expect(reply.status).toBe(200);
    const out = JSON.parse(reply.body) as { title: string; count: number; files: { field: string; size: number; bytes: number[] }[] };
    expect(out.title).toBe("hi");
    expect(out.count).toBe(3);
    expect(out.files.map((f) => [f.field, f.size])).toEqual([["photo", PNG.length], ["doc", 1]]);
    expect(out.files[0]!.bytes).toEqual(Array.from(PNG));
  });

  test("invalid fields -> 422", async () => {
    const reply = await send(makeApp(), "/up", type, cat([field(b, "count", "x"), `--${b}--\r\n`]));
    expect(reply.status).toBe(422);
  });

  test("bad boundary -> 400, missing boundary -> 400", async () => {
    const body = cat([field(b, "title", "hi"), `--${b}--\r\n`]);
    expect((await send(makeApp(), "/up", { "content-type": "multipart/form-data; boundary=other" }, body)).status).toBe(400);
    expect((await send(makeApp(), "/up", { "content-type": "multipart/form-data" }, body)).status).toBe(400);
    const r = await send(makeApp(), "/up", { "content-type": "multipart/form-data; boundary=other" }, body);
    expect(JSON.parse(r.body)).toMatchObject({ error: { code: "invalid_multipart" } });
  });

  test("file over the action limit -> 413", async () => {
    const reply = await send(makeApp(), "/up/small", type, cat([...file(b, "f", "f.bin", "x/y", PNG), `--${b}--\r\n`]));
    expect(reply.status).toBe(413);
  });

  test("JSON still works on an upload action", async () => {
    const reply = await send(makeApp(), "/up", { "content-type": "application/json" }, enc.encode('{"title":"j"}'));
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({ title: "j", count: 0, files: [] });
  });
});

describe("JSON bodies and 415", () => {
  test("json body unchanged (string body and raw bytes)", async () => {
    const app = makeApp();
    const a = await app.handle(new RequestData("POST", "/up/plain", { "content-type": "application/json" }, '{"a":"é"}', "x"));
    expect(JSON.parse(a.body)).toEqual({ a: "é" });
    const bytes = await send(app, "/up/plain", { "content-type": "application/json" }, enc.encode('{"a":"é"}'));
    expect(JSON.parse(bytes.body)).toEqual({ a: "é" });
    expect((await send(app, "/up/plain", { "content-type": "application/json" }, enc.encode("{nope"))).status).toBe(400);
  });

  test("RequestData exposes both views", () => {
    const r = new RequestData("POST", "/", {}, "héllo", "x");
    expect(r.raw.length).toBe(6);
    expect(r.body).toBe("héllo");
    const b = new RequestData("POST", "/", {}, "", "x", new Uint8Array([0xff, 0x00]));
    expect(b.raw.length).toBe(2);
    expect(b.empty).toBe(false);
  });

  test("non-JSON body without multipart -> 415 (also multipart on a JSON-only action)", async () => {
    const app = makeApp();
    expect((await send(app, "/up/plain", { "content-type": "text/plain" }, enc.encode("a=1"))).status).toBe(415);
    const b = "q";
    expect((await send(app, "/up/plain", { "content-type": `multipart/form-data; boundary=${b}` }, cat([field(b, "a", "1"), `--${b}--`]))).status).toBe(415);
  });
});

describe("cookies", () => {
  test("parse", () => {
    expect(parseCookies('a=1; b="two"; c=x%20y; bad; a=9')).toEqual({ a: "1", b: "two", c: "x y" });
    expect(parseCookies("")).toEqual({});
  });

  test("serialize", () => {
    expect(serializeCookie("a", "b c")).toBe("a=b%20c; Path=/");
    expect(serializeCookie("a", "1", { httpOnly: true, secure: true, sameSite: "strict", path: "/p", domain: "x.test", maxAge: 5, expires: new Date(0) })).toBe(
      "a=1; Path=/p; Domain=x.test; Max-Age=5; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict",
    );
    expect(() => serializeCookie("a b", "1")).toThrow();
  });

  test("ctx.cookie and multiple Set-Cookie through the app", async () => {
    const reply = await send(makeApp(), "/up/cookies", { cookie: "sid=a%20b%3Bc; x=1" }, new Uint8Array(0), "GET");
    expect(JSON.parse(reply.body)).toEqual({ sid: "a b;c", missing: null });
    expect(reply.cookies.length).toBe(3);
    expect(reply.cookies[0]).toBe("sid=a%20b%3Bc; Path=/app; Max-Age=60; HttpOnly; Secure; SameSite=Lax");
    expect(reply.cookies[1]).toBe("theme=dark; Path=/");
    expect(reply.cookies[2]).toContain("old=; Path=/x; Max-Age=0; Expires=Thu, 01 Jan 1970");
  });

  test("over a real server: two Set-Cookie headers and a binary upload", async () => {
    const port = 39000 + Math.floor(Math.random() * 500);
    await serve(makeApp(), { port, host: "127.0.0.1" });
    const res = await fetch(`http://127.0.0.1:${port}/up/cookies`, { headers: { cookie: "sid=zz" } });
    expect(res.headers.getSetCookie().length).toBe(3);
    const form = new FormData();
    form.append("title", "hello");
    form.append("file", new Blob([PNG], { type: "image/png" }), "x.png");
    const up = await fetch(`http://127.0.0.1:${port}/up`, { method: "POST", body: form });
    const out = (await up.json()) as { title: string; files: { size: number; bytes: number[] }[] };
    expect(out.title).toBe("hello");
    expect(out.files[0]!.bytes).toEqual(Array.from(PNG));
  });
});
