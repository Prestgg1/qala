import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";
import { buildMessage, dotStuff, encodeWords, parseAddress, quotedPrintable, SmtpClient, SmtpError } from "@qala/core";

type Captured = { from: string; rcpts: string[]; data: string; auth: string[]; tls: boolean; ehlos: number };

type Behavior = { auth?: "plain" | "login" | "none"; rejectRcpt?: string; rejectAuth?: boolean; silent?: boolean; startTls?: boolean; key?: string; cert?: string };

/** A tiny scripted SMTP server: records one transaction per connection. */
function fakeServer(behavior: Behavior, secure: { key: string; cert: string } | null = null): Promise<{ server: Server; port: number; mails: Captured[] }> {
  const mails: Captured[] = [];
  const handle = (raw: Socket): void => {
    let socket: Socket = raw;
    const cur: Captured = { from: "", rcpts: [], data: "", auth: [], tls: secure !== null, ehlos: 0 };
    let buf = "";
    let inData = false;
    let loginStep = 0;
    const send = (s: string) => socket.write(`${s}\r\n`);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          cur.data = buf.slice(0, end + 2);
          buf = buf.slice(end + 5);
          inData = false;
          mails.push({ ...cur, rcpts: [...cur.rcpts] });
          send("250 queued as 42");
          continue;
        }
        const at = buf.indexOf("\r\n");
        if (at < 0) return;
        const line = buf.slice(0, at);
        buf = buf.slice(at + 2);
        if (loginStep > 0) {
          cur.auth.push(Buffer.from(line, "base64").toString("utf8"));
          if (loginStep === 1) {
            loginStep = 2;
            send("334 UGFzc3dvcmQ6");
          } else {
            loginStep = 0;
            send(behavior.rejectAuth ? "535 5.7.8 bad credentials" : "235 ok");
          }
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO")) {
          cur.ehlos++;
          const feats = ["250-fake.local"];
          if (behavior.startTls && !(socket instanceof TLSSocket)) feats.push("250-STARTTLS");
          if (behavior.auth === "plain") feats.push("250-AUTH PLAIN LOGIN");
          if (behavior.auth === "login") feats.push("250-AUTH LOGIN");
          feats.push("250 8BITMIME");
          send(feats.join("\r\n"));
        } else if (upper === "STARTTLS") {
          send("220 go ahead");
          const upgraded = new TLSSocket(socket, { isServer: true, key: behavior.key, cert: behavior.cert });
          socket.removeAllListeners("data");
          socket = upgraded;
          cur.tls = true;
          upgraded.on("data", onData);
          upgraded.on("error", () => {});
          buf = "";
          return;
        } else if (upper.startsWith("AUTH PLAIN")) {
          cur.auth.push(Buffer.from(line.slice(11), "base64").toString("utf8"));
          send(behavior.rejectAuth ? "535 5.7.8 bad credentials" : "235 ok");
        } else if (upper === "AUTH LOGIN") {
          loginStep = 1;
          send("334 VXNlcm5hbWU6");
        } else if (upper.startsWith("MAIL FROM:")) {
          cur.from = line.slice(10);
          send("250 ok");
        } else if (upper.startsWith("RCPT TO:")) {
          const rcpt = line.slice(8);
          if (behavior.rejectRcpt !== undefined && rcpt.includes(behavior.rejectRcpt)) send("550 5.1.1 no such user");
          else {
            cur.rcpts.push(rcpt);
            send("250 ok");
          }
        } else if (upper === "DATA") {
          inData = true;
          send("354 go");
        } else if (upper === "QUIT") {
          send("221 bye");
          socket.end();
          return;
        } else send("500 what?");
      }
    };
    if (behavior.silent) return;
    raw.on("data", onData);
    raw.on("error", () => {});
    send("220 fake.local ESMTP");
  };
  const server = createServer(handle);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port, mails })));
}

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});
async function start(b: Behavior) {
  const f = await fakeServer(b);
  servers.push(f.server);
  return f;
}

const base = { host: "127.0.0.1", from: "Qala <noreply@example.com>" };

describe("message building", () => {
  test("encoded-words, quoted-printable and dot-stuffing", () => {
    expect(encodeWords("plain")).toBe("plain");
    const w = encodeWords("Salam dünya — ağıllı mətn ".repeat(4));
    for (const line of w.split("\r\n")) expect(line.trim().length).toBeLessThanOrEqual(75);
    const decoded = w.split("\r\n").map((l) => Buffer.from(l.trim().slice(10, -2), "base64").toString("utf8")).join("");
    expect(decoded).toBe("Salam dünya — ağıllı mətn ".repeat(4));
    expect(quotedPrintable("a=b é\nend \n")).toBe("a=3Db =C3=A9\r\nend=20\r\n");
    const long = quotedPrintable("x".repeat(200));
    for (const l of long.split("\r\n")) expect(l.length).toBeLessThanOrEqual(76);
    expect(long.replace(/=\r\n/g, "")).toBe("x".repeat(200));
    expect(dotStuff("a\r\n.b\r\n..c")).toBe("a\r\n..b\r\n...c");
    expect(parseAddress('"Doe, J" <j@x.io>')).toEqual({ name: "Doe, J", email: "j@x.io" });
    expect(() => parseAddress("nope")).toThrow(SmtpError);
  });

  test("multipart/alternative and headers", () => {
    const m = buildMessage("a@x.io", { to: ["Bob <b@y.io>", "c@y.io"], cc: ["d@y.io"], bcc: ["secret@y.io"], subject: "Hej ü", text: "t", html: "<p>h</p>", replyTo: "r@x.io", headers: { "X-Test": "1" } }, "<id@x.io>", new Date(0));
    expect(m).toContain("To: Bob <b@y.io>, c@y.io\r\n");
    expect(m).toContain("Cc: d@y.io\r\n");
    expect(m).not.toContain("secret@y.io");
    expect(m).toContain("Subject: =?UTF-8?B?");
    expect(m).toContain("Content-Type: multipart/alternative; boundary=");
    expect(m).toContain("Content-Type: text/plain; charset=utf-8");
    expect(m).toContain("Content-Type: text/html; charset=utf-8");
    expect(m).toContain("X-Test: 1\r\n");
    expect(m.replace(/\r\n/g, "").includes("\n")).toBe(false);
    expect(() => buildMessage("a@x.io", { to: ["b@y.io"], subject: "x\r\nBcc: evil@z.io" }, "<i>", new Date())).toThrow(SmtpError);
  });
});

describe("SmtpClient (plain)", () => {
  test("sends to several recipients with AUTH PLAIN, dot-stuffing and UTF-8", async () => {
    const f = await start({ auth: "plain" });
    const client = new SmtpClient({ ...base, port: f.port, user: "me", pass: "s3cret" });
    const r = await client.send({ to: ["a@x.io", "B <b@x.io>"], cc: ["c@x.io"], bcc: ["d@x.io"], subject: "Salam ə", text: "line1\n.dot line\nünicode", html: "<b>hi</b>" });
    expect(r.accepted).toEqual(["a@x.io", "b@x.io", "c@x.io", "d@x.io"]);
    const mail = f.mails[0]!;
    expect(mail.from).toBe("<noreply@example.com>");
    expect(mail.rcpts).toEqual(["<a@x.io>", "<b@x.io>", "<c@x.io>", "<d@x.io>"]);
    expect(mail.auth).toEqual(["\0me\0s3cret"]);
    expect(mail.data).toContain("multipart/alternative");
    expect(mail.data).toContain("\r\n..dot line"); // stuffed on the wire
    expect(mail.data).toContain("=C3=BCnicode");
    expect(mail.data).not.toContain("Bcc");
    expect(mail.tls).toBe(false);
  });

  test("AUTH LOGIN when only LOGIN is offered", async () => {
    const f = await start({ auth: "login" });
    await new SmtpClient({ ...base, port: f.port, user: "me", pass: "pw" }).send({ to: ["a@x.io"], subject: "s", text: "t" });
    expect(f.mails[0]!.auth).toEqual(["me", "pw"]);
  });

  test("error codes surface as SmtpError", async () => {
    const f = await start({ auth: "plain", rejectAuth: true });
    const err = await new SmtpClient({ ...base, port: f.port, user: "me", pass: "bad" }).send({ to: ["a@x.io"], subject: "s", text: "t" }).catch((e) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect(err.code).toBe(535);
    const g = await start({ rejectRcpt: "nobody" });
    const e2 = await new SmtpClient({ ...base, port: g.port }).send({ to: ["nobody@x.io"], subject: "s", text: "t" }).catch((e) => e);
    expect(e2).toBeInstanceOf(SmtpError);
    expect(e2.code).toBe(550);
    expect(e2.message).toContain("no such user");
  });

  test("times out when the server never answers; refused connections are SmtpErrors", async () => {
    const f = await start({ silent: true });
    const err = await new SmtpClient({ ...base, port: f.port, timeout: 200 }).send({ to: ["a@x.io"], subject: "s", text: "t" }).catch((e) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect(err.code).toBe(0);
    expect(err.message).toContain("timed out");
    const refused = await new SmtpClient({ ...base, port: 1, timeout: 500 }).send({ to: ["a@x.io"], subject: "s", text: "t" }).catch((e) => e);
    expect(refused).toBeInstanceOf(SmtpError);
  });

  test("startTls fails clearly when the server does not offer it", async () => {
    const f = await start({});
    const err = await new SmtpClient({ ...base, port: f.port, startTls: true }).send({ to: ["a@x.io"], subject: "s", text: "t" }).catch((e) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect(err.message).toContain("STARTTLS");
  });
});

describe("SmtpClient (TLS)", () => {
  let key = "";
  let cert = "";
  const dir = mkdtempSync(join(tmpdir(), "qala-smtp-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
    key = readFileSync(join(dir, "k.pem"), "utf8");
    cert = readFileSync(join(dir, "c.pem"), "utf8");
  } catch {
    // no openssl: the TLS tests below are skipped
  }
  rmSync(dir, { recursive: true, force: true });
  const tls = key === "" ? test.skip : test;

  // Bun cannot wrap an accepted socket in a server-side TLSSocket, so the STARTTLS server runs under Node.
  async function nodeStartTlsServer(): Promise<{ port: number; child: ReturnType<typeof spawn>; mails: () => Promise<string[]> }> {
    const keyFile = join(tmpdir(), `qala-smtp-${process.pid}-k.pem`);
    const certFile = join(tmpdir(), `qala-smtp-${process.pid}-c.pem`);
    writeFileSync(keyFile, key);
    writeFileSync(certFile, cert);
    const child = spawn("node", [join(import.meta.dir, "fixtures", "starttls-server.mjs"), keyFile, certFile], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    const waiters: (() => void)[] = [];
    child.stdout!.on("data", (c: Buffer) => {
      out += c.toString();
      for (const w of waiters.splice(0)) w();
    });
    const lines = (prefix: string) => out.split("\n").filter((l) => l.startsWith(prefix));
    const until = async (prefix: string) => {
      for (let i = 0; i < 100 && lines(prefix).length === 0; i++) await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); });
      return lines(prefix).map((l) => l.slice(prefix.length));
    };
    const port = Number((await until("PORT "))[0]);
    return { port, child, mails: () => until("MAIL ") };
  }
  const nodeAvailable = (() => {
    try {
      execFileSync("node", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  const tlsNode = key !== "" && nodeAvailable ? test : test.skip;

  tlsNode("STARTTLS upgrade, then AUTH over TLS", async () => {
    const f = await nodeStartTlsServer();
    try {
      await new SmtpClient({ ...base, port: f.port, startTls: true, user: "u", pass: "p", rejectUnauthorized: false }).send({ to: ["a@x.io"], subject: "tls", text: "hello" });
      const mail = JSON.parse((await f.mails())[0]!);
      expect(mail.tls).toBe(true);
      expect(mail.ehlos).toBe(2);
      expect(mail.auth).toEqual(["\0u\0p"]);
      expect(mail.data).toContain("Subject: tls");
    } finally {
      f.child.kill();
    }
  });

  tlsNode("a self-signed certificate is rejected by default", async () => {
    const f = await nodeStartTlsServer();
    try {
      const err = await new SmtpClient({ ...base, port: f.port, startTls: true }).send({ to: ["a@x.io"], subject: "s", text: "t" }).catch((e) => e);
      expect(err).toBeInstanceOf(SmtpError);
      expect(err.message).toContain("TLS");
    } finally {
      f.child.kill();
    }
  });

  tls("implicit TLS (secure: true)", async () => {
    const { createServer: createTls } = await import("node:tls");
    const mails: string[] = [];
    const server = createTls({ key, cert }, (s) => {
      let buf = "";
      let data = false;
      s.write("220 hi\r\n");
      s.on("data", (c) => {
        buf += c.toString();
        for (;;) {
          if (data) {
            const e = buf.indexOf("\r\n.\r\n");
            if (e < 0) return;
            mails.push(buf.slice(0, e));
            buf = buf.slice(e + 5);
            data = false;
            s.write("250 ok\r\n");
            continue;
          }
          const at = buf.indexOf("\r\n");
          if (at < 0) return;
          const line = buf.slice(0, at);
          buf = buf.slice(at + 2);
          if (line.startsWith("EHLO")) s.write("250 fake\r\n");
          else if (line === "DATA") {
            data = true;
            s.write("354 go\r\n");
          } else if (line === "QUIT") s.end("221 bye\r\n");
          else s.write("250 ok\r\n");
        }
      });
      s.on("error", () => {});
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server as unknown as Server);
    const port = (server.address() as { port: number }).port;
    await new SmtpClient({ ...base, port, secure: true, rejectUnauthorized: false }).send({ to: ["a@x.io"], subject: "implicit", text: "over tls" });
    expect(mails.length).toBe(1);
    expect(mails[0]).toContain("Subject: implicit");
  });
});
