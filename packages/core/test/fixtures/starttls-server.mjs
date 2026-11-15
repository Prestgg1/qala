// Fake SMTP server with STARTTLS for smtp.test.ts. Bun cannot wrap an accepted socket in a server-side
// TLSSocket, so the test runs this under Node. Usage: node starttls-server.mjs <key.pem> <cert.pem>
// Prints "PORT <n>" when listening and "MAIL <json>" after each accepted message.
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { TLSSocket } from "node:tls";

const key = readFileSync(process.argv[2], "utf8");
const cert = readFileSync(process.argv[3], "utf8");

createServer((raw) => {
  let socket = raw;
  let tls = false;
  let ehlos = 0;
  const mail = { from: "", rcpts: [], data: "", auth: [], tls: false, ehlos: 0 };
  let buf = "";
  let inData = false;
  const send = (s) => socket.write(`${s}\r\n`);
  const onData = (chunk) => {
    buf += chunk.toString("utf8");
    for (;;) {
      if (inData) {
        const end = buf.indexOf("\r\n.\r\n");
        if (end < 0) return;
        mail.data = buf.slice(0, end + 2);
        buf = buf.slice(end + 5);
        inData = false;
        console.log(`MAIL ${JSON.stringify({ ...mail, tls, ehlos })}`);
        send("250 queued");
        continue;
      }
      const at = buf.indexOf("\r\n");
      if (at < 0) return;
      const line = buf.slice(0, at);
      buf = buf.slice(at + 2);
      const upper = line.toUpperCase();
      if (upper.startsWith("EHLO")) {
        ehlos++;
        send(["250-fake.local", ...(tls ? [] : ["250-STARTTLS"]), "250 AUTH PLAIN LOGIN"].join("\r\n"));
      } else if (upper === "STARTTLS") {
        send("220 go ahead");
        raw.removeAllListeners("data");
        socket = new TLSSocket(raw, { isServer: true, key, cert });
        socket.on("data", onData);
        socket.on("error", () => {});
        tls = true;
        buf = "";
        return;
      } else if (upper.startsWith("AUTH PLAIN")) {
        mail.auth.push(Buffer.from(line.slice(11), "base64").toString("utf8"));
        send("235 ok");
      } else if (upper.startsWith("MAIL FROM:")) {
        mail.from = line.slice(10);
        send("250 ok");
      } else if (upper.startsWith("RCPT TO:")) {
        mail.rcpts.push(line.slice(8));
        send("250 ok");
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
  raw.on("data", onData);
  raw.on("error", () => {});
  send("220 fake.local ESMTP");
}).listen(0, "127.0.0.1", function () {
  console.log(`PORT ${this.address().port}`);
});
