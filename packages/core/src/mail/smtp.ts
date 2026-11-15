/**
 * An SMTP client written for scriptc's static subset (node:net / node:tls): implicit TLS or STARTTLS,
 * AUTH PLAIN / LOGIN, multiple recipients, and MIME messages (UTF-8 subjects as RFC 2047 encoded-words,
 * quoted-printable bodies, multipart/alternative, dot-stuffing, CRLF line ends).
 */
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { randomBytes } from "node:crypto";

/**
 * An error from the SMTP server or the connection. `code` is the SMTP reply code (e.g. 550, 535);
 * 0 means there was no reply (timeout, connection closed, TLS failure, unsupported server).
 */
export class SmtpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export type SmtpOptions = {
  host: string;
  port: number;
  /** Implicit TLS: the connection is TLS from the first byte (port 465). */
  secure?: boolean;
  /** Upgrade a plain connection with STARTTLS (port 587); fails if the server does not offer it. */
  startTls?: boolean;
  user?: string;
  pass?: string;
  /** Envelope sender and From header: `a@b.c` or `Name <a@b.c>`. */
  from: string;
  /** Milliseconds to wait for each reply (and the connection). Default 30000. */
  timeout?: number;
  /** Verify the server certificate (default true); set false only for development with self-signed certs. */
  rejectUnauthorized?: boolean;
  /** Name sent in EHLO. Default: the domain of `from`. */
  hostname?: string;
};

export type MailMessage = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  /** Extra headers (e.g. `X-Mailer`); they must not contain line breaks. */
  headers?: Record<string, string>;
};

export class SendResult {
  constructor(
    readonly messageId: string,
    readonly accepted: string[],
  ) {}
}

class Reply {
  constructor(
    readonly code: number,
    readonly lines: string[],
  ) {}
  get text(): string {
    return this.lines.join("\n");
  }
}

class Address {
  constructor(
    readonly name: string,
    readonly email: string,
  ) {}
}

const CRLF = "\r\n";

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 126 || s.charCodeAt(i) < 32) return false;
  return true;
}

function checkLine(what: string, value: string): string {
  if (value.includes("\r") || value.includes("\n")) throw new SmtpError(0, `${what} must not contain line breaks`);
  return value;
}

/** `Name <a@b.c>` or `a@b.c` → name and bare address. */
export function parseAddress(input: string): Address {
  const text = checkLine("address", input).trim();
  const m = /^(.*)<([^<>]+)>\s*$/.exec(text);
  if (m === null) {
    if (!/^[^\s<>@]+@[^\s<>@]+$/.test(text)) throw new SmtpError(0, `invalid address: ${input}`);
    return new Address("", text);
  }
  const email = (m[2] ?? "").trim();
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(email)) throw new SmtpError(0, `invalid address: ${input}`);
  let name = (m[1] ?? "").trim();
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  return new Address(name, email);
}

/** RFC 2047 encoded-words (`=?UTF-8?B?...?=`), folded onto continuation lines; ASCII text is returned as is. */
export function encodeWords(text: string): string {
  checkLine("header", text);
  if (isAscii(text)) return text;
  const words: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, "utf8");
    if (chunkBytes + n > 45) {
      words.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += ch;
    chunkBytes += n;
  }
  if (chunk !== "") words.push(chunk);
  const encoded: string[] = [];
  for (const w of words) encoded.push(`=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`);
  return encoded.join(CRLF + " ");
}

function formatAddress(a: Address): string {
  if (a.name === "") return a.email;
  if (!isAscii(a.name)) return `${encodeWords(a.name)} <${a.email}>`;
  if (/^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]+$/.test(a.name)) return `${a.name} <${a.email}>`;
  return `"${a.name.replace(/(["\\])/g, "\\$1")}" <${a.email}>`;
}

function formatList(list: Address[]): string {
  const parts: string[] = [];
  for (const a of list) parts.push(formatAddress(a));
  return parts.join(", ");
}

/** Quoted-printable (RFC 2045) of UTF-8 text, soft-wrapped at 76 columns, CRLF line ends. */
export function quotedPrintable(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const bytes = Buffer.from(line, "utf8");
    let current = "";
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      const trailing = i === bytes.length - 1;
      let token: string;
      if (b === 61 || b > 126 || b < 32 && b !== 9 || (b === 32 || b === 9) && trailing) token = `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
      else token = String.fromCharCode(b);
      if (current.length + token.length > (trailing ? 76 : 75)) {
        out.push(`${current}=`);
        current = "";
      }
      current += token;
    }
    out.push(current);
  }
  return out.join(CRLF);
}

/** Dot-stuffing (RFC 5321 4.5.2): a line starting with "." gets another "." in front. */
export function dotStuff(message: string): string {
  const lines = message.split(CRLF);
  for (let i = 0; i < lines.length; i++) if (lines[i]!.startsWith(".")) lines[i] = `.${lines[i]}`;
  return lines.join(CRLF);
}

function mimePart(contentType: string, body: string): string {
  return `Content-Type: ${contentType}; charset=utf-8${CRLF}Content-Transfer-Encoding: quoted-printable${CRLF}${CRLF}${quotedPrintable(body)}`;
}

/** Builds the full message (headers + body, CRLF, no trailing dot) for `from`; also used by tests. */
export function buildMessage(from: string, message: MailMessage, messageId: string, date: Date): string {
  const sender = parseAddress(from);
  const to: Address[] = [];
  for (const a of message.to) to.push(parseAddress(a));
  const cc: Address[] = [];
  for (const a of message.cc ?? []) cc.push(parseAddress(a));
  const head: string[] = [];
  head.push(`Date: ${date.toUTCString().replace("GMT", "+0000")}`);
  head.push(`Message-ID: ${messageId}`);
  head.push(`From: ${formatAddress(sender)}`);
  if (to.length > 0) head.push(`To: ${formatList(to)}`);
  if (cc.length > 0) head.push(`Cc: ${formatList(cc)}`);
  if (message.replyTo !== undefined) head.push(`Reply-To: ${formatAddress(parseAddress(message.replyTo))}`);
  head.push(`Subject: ${encodeWords(message.subject)}`);
  head.push("MIME-Version: 1.0");
  const extra = message.headers ?? {};
  for (const name of Object.keys(extra)) {
    if (!/^[A-Za-z0-9-]+$/.test(name)) throw new SmtpError(0, `invalid header name: ${name}`);
    head.push(`${name}: ${encodeWords(extra[name] ?? "")}`);
  }
  const text = message.text;
  const html = message.html;
  let body: string;
  if (text !== undefined && html !== undefined) {
    const boundary = `=_qala_${randomBytes(12).toString("hex")}`;
    head.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = `--${boundary}${CRLF}${mimePart("text/plain", text)}${CRLF}--${boundary}${CRLF}${mimePart("text/html", html)}${CRLF}--${boundary}--`;
  } else if (html !== undefined) {
    const part = mimePart("text/html", html);
    const split = part.indexOf(CRLF + CRLF);
    head.push(part.slice(0, split).replace(/\r\n/g, CRLF));
    body = part.slice(split + 4);
  } else {
    const part = mimePart("text/plain", text ?? "");
    const split = part.indexOf(CRLF + CRLF);
    head.push(part.slice(0, split));
    body = part.slice(split + 4);
  }
  return `${head.join(CRLF)}${CRLF}${CRLF}${body}${CRLF}`;
}

/** One connection's state: buffers server data and hands out complete replies. */
class Session {
  socket: Socket;
  private buffer = "";
  /** Bumped when the socket is replaced (TLS upgrade) so the old socket's data is ignored. */
  private generation = 0;
  private lines: string[] = [];
  private failure: Error | null = null;
  private waiter: ((reply: Reply) => void) | null = null;
  private waiterFail: ((err: Error) => void) | null = null;

  constructor(
    socket: Socket,
    private readonly timeout: number,
  ) {
    this.socket = socket;
    this.attach(socket);
  }

  attach(socket: Socket): void {
    this.socket = socket;
    const generation = ++this.generation;
    socket.on("data", (chunk: Buffer) => {
      if (generation !== this.generation) return;
      this.buffer += chunk.toString("utf8");
      this.pump();
    });
    socket.on("error", (err: Error) => this.fail(new SmtpError(0, `connection error: ${err.message}`)));
    socket.on("close", () => this.fail(new SmtpError(0, "connection closed by the server")));
  }

  /** Stops listening to the plain socket before a TLS upgrade wraps it. */
  detach(): void {
    this.generation++;
    this.buffer = "";
  }

  private fail(err: Error): void {
    if (this.failure === null) this.failure = err;
    const reject = this.waiterFail;
    this.waiter = null;
    this.waiterFail = null;
    if (reject !== null) reject(err);
  }

  private pump(): void {
    for (;;) {
      const at = this.buffer.indexOf("\n");
      if (at < 0) return;
      const line = this.buffer.slice(0, at).replace(/\r$/, "");
      this.buffer = this.buffer.slice(at + 1);
      this.lines.push(line);
      // a final line is "NNN text" or "NNN"; continuation lines are "NNN-text"
      if (/^\d{3}( |$)/.test(line)) {
        const resolve = this.waiter;
        if (resolve === null) continue;
        this.waiter = null;
        this.waiterFail = null;
        const collected = this.lines;
        this.lines = [];
        resolve(this.toReply(collected));
        continue;
      }
    }
  }

  private toReply(collected: string[]): Reply {
    const texts: string[] = [];
    for (const l of collected) texts.push(l.slice(4));
    return new Reply(Number(collected[collected.length - 1]!.slice(0, 3)), texts);
  }

  /** The next complete reply (buffered or yet to come), or an `SmtpError` on timeout / closed connection. */
  read(): Promise<Reply> {
    if (this.lines.length > 0 && /^\d{3}( |$)/.test(this.lines[this.lines.length - 1]!)) {
      const collected = this.lines;
      this.lines = [];
      return Promise.resolve(this.toReply(collected));
    }
    if (this.failure !== null) return Promise.reject(this.failure);
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        this.waiterFail = null;
        reject(new SmtpError(0, `timed out after ${this.timeout} ms waiting for the server`));
      }, this.timeout);
      this.waiter = (reply) => {
        clearTimeout(timer);
        resolve(reply);
      };
      this.waiterFail = (err) => {
        clearTimeout(timer);
        reject(err);
      };
    });
  }

  write(data: string): void {
    this.socket.write(data);
  }

  destroy(): void {
    this.socket.destroy();
  }
}

export class SmtpClient {
  private readonly timeout: number;

  constructor(private readonly options: SmtpOptions) {
    this.timeout = options.timeout ?? 30000;
  }

  /** Sends one message over a fresh connection. Rejects with `SmtpError` on any failure. */
  async send(message: MailMessage): Promise<SendResult> {
    const o = this.options;
    const sender = parseAddress(o.from);
    const recipients: string[] = [];
    for (const list of [message.to, message.cc ?? [], message.bcc ?? []]) for (const a of list) recipients.push(parseAddress(a).email);
    if (recipients.length === 0) throw new SmtpError(0, "no recipients");
    const domain = sender.email.slice(sender.email.indexOf("@") + 1);
    const messageId = `<${randomBytes(12).toString("hex")}@${domain}>`;
    const data = dotStuff(buildMessage(o.from, message, messageId, new Date()));

    const session = await this.connect();
    try {
      await this.expect(session, [220]);
      const hostname = o.hostname ?? domain;
      let features = await this.ehlo(session, hostname);
      if (o.startTls === true && o.secure !== true) {
        if (!features.some((f) => f.toUpperCase() === "STARTTLS")) throw new SmtpError(0, "the server does not offer STARTTLS");
        session.write(`STARTTLS${CRLF}`);
        await this.expect(session, [220]);
        await this.upgrade(session);
        features = await this.ehlo(session, hostname);
      }
      if (o.user !== undefined && o.user !== "") await this.authenticate(session, features, o.user, o.pass ?? "");
      session.write(`MAIL FROM:<${sender.email}>${CRLF}`);
      await this.expect(session, [250]);
      for (const r of recipients) {
        session.write(`RCPT TO:<${r}>${CRLF}`);
        await this.expect(session, [250, 251]);
      }
      session.write(`DATA${CRLF}`);
      await this.expect(session, [354]);
      session.write(`${data}.${CRLF}`);
      await this.expect(session, [250]);
      try {
        session.write(`QUIT${CRLF}`);
      } catch {
        // already gone; the message was accepted
      }
      return new SendResult(messageId, recipients);
    } finally {
      session.destroy();
    }
  }

  private async connect(): Promise<Session> {
    const o = this.options;
    const socket: Socket = o.secure === true ? tlsConnect({ host: o.host, port: o.port, servername: this.serverName(), rejectUnauthorized: o.rejectUnauthorized ?? true }) : netConnect(o.port, o.host);
    return new Session(socket, this.timeout);
  }

  /** SNI name: the host, except for IP addresses (not allowed there). */
  private serverName(): string | undefined {
    return isIP(this.options.host) !== 0 ? undefined : this.options.host;
  }

  private upgrade(session: Session): Promise<void> {
    const o = this.options;
    session.detach();
    const secured = tlsConnect({ socket: session.socket, servername: this.serverName(), rejectUnauthorized: o.rejectUnauthorized ?? true });
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new SmtpError(0, "TLS handshake timed out")), this.timeout);
      secured.once("secureConnect", () => {
        clearTimeout(timer);
        session.attach(secured);
        resolve();
      });
      secured.once("error", (err: Error) => {
        clearTimeout(timer);
        reject(new SmtpError(0, `TLS handshake failed: ${err.message}`));
      });
    });
  }

  /** Reads a reply and requires one of `codes`; otherwise throws `SmtpError(code, text)`. */
  private async expect(session: Session, codes: number[]): Promise<Reply> {
    const reply = await session.read();
    if (!codes.includes(reply.code)) throw new SmtpError(reply.code, reply.text);
    return reply;
  }

  private async ehlo(session: Session, hostname: string): Promise<string[]> {
    session.write(`EHLO ${hostname}${CRLF}`);
    const reply = await session.read();
    if (reply.code !== 250) throw new SmtpError(reply.code, reply.text);
    return reply.lines.slice(1);
  }

  private async authenticate(session: Session, features: string[], user: string, pass: string): Promise<void> {
    let mechanisms = "";
    for (const f of features) {
      const upper = f.toUpperCase();
      if (upper.startsWith("AUTH ") || upper.startsWith("AUTH=")) mechanisms += ` ${upper.slice(5)}`;
    }
    const offered = mechanisms.split(" ");
    if (offered.includes("PLAIN")) {
      const token = Buffer.from(`\0${user}\0${pass}`, "utf8").toString("base64");
      session.write(`AUTH PLAIN ${token}${CRLF}`);
      await this.expect(session, [235]);
    } else if (offered.includes("LOGIN")) {
      session.write(`AUTH LOGIN${CRLF}`);
      await this.expect(session, [334]);
      session.write(`${Buffer.from(user, "utf8").toString("base64")}${CRLF}`);
      await this.expect(session, [334]);
      session.write(`${Buffer.from(pass, "utf8").toString("base64")}${CRLF}`);
      await this.expect(session, [235]);
    } else {
      throw new SmtpError(0, `the server offers no supported AUTH mechanism (${mechanisms.trim() || "none"})`);
    }
  }
}
