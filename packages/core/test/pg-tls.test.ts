import { describe, expect, test } from "bun:test";
import { Connection, parseUrl, type ConnectionConfig } from "../src/db/pg";

const URL = process.env.QALA_TEST_DATABASE_URL ?? "postgres://qala:qala@localhost:5432/qala_test";
/** PEM of the CA that signed the test server's certificate (CI's tls job sets it). */
const CA = process.env.QALA_TEST_TLS_CA ?? "";
/** PEM of an unrelated CA, to check that verification really rejects. */
const OTHER_CA = process.env.QALA_TEST_TLS_OTHER_CA ?? "";

describe("parseUrl sslmode", () => {
  test("defaults to prefer, like libpq", () => {
    expect(parseUrl("postgres://u:p@h/db").sslmode).toBe("prefer");
  });
  test("reads sslmode and sslrootcert, decoding them", () => {
    const c = parseUrl("postgres://u:p@h:6543/db?sslmode=verify-full&sslrootcert=%2Fetc%2Fca%20dir%2Fca.pem&application_name=x");
    expect(c).toMatchObject({ host: "h", port: 6543, database: "db", sslmode: "verify-full", sslrootcert: "/etc/ca dir/ca.pem" });
  });
  test("ssl=true means require; allow is treated as prefer", () => {
    expect(parseUrl("postgres://u:p@h/db?ssl=true").sslmode).toBe("require");
    expect(parseUrl("postgres://u:p@h/db?sslmode=allow").sslmode).toBe("prefer");
    expect(parseUrl("postgres://u:p@h/db?sslmode=disable&ssl=true").sslmode).toBe("disable");
  });
  test("database name stops at the query string", () => {
    expect(parseUrl("postgres://u:p@h/my_db?sslmode=require").database).toBe("my_db");
  });
  test("unknown sslmode is an error, not a silent downgrade", () => {
    expect(() => parseUrl("postgres://u:p@h/db?sslmode=verify_full")).toThrow(/unknown sslmode/);
  });
});

async function open(overrides: Partial<ConnectionConfig>): Promise<Connection> {
  const c = new Connection({ ...parseUrl(URL), ...overrides });
  await c.open();
  return c;
}

async function sslInUse(c: Connection): Promise<boolean> {
  const r = await c.query("select ssl from pg_stat_ssl where pid = pg_backend_pid()", []);
  return r.rows[0]?.["ssl"] === true;
}

/** Whether the test server speaks TLS at all (CI's main job: no; the tls job and a TLS-enabled local server: yes). */
const serverTls = await (async () => {
  try {
    const c = await open({ sslmode: "prefer" });
    const on = c.encrypted;
    c.close();
    return on;
  } catch {
    return false;
  }
})();

describe("TLS against the test server", () => {
  test("disable never encrypts", async () => {
    const c = await open({ sslmode: "disable" });
    expect(c.encrypted).toBe(false);
    expect(await sslInUse(c)).toBe(false);
    c.close();
  });

  test.skipIf(serverTls)("without server TLS: prefer falls back to plain, require refuses", async () => {
    const c = await open({ sslmode: "prefer" });
    expect(c.encrypted).toBe(false);
    c.close();
    await expect(open({ sslmode: "require" })).rejects.toThrow(/does not support TLS/);
  });

  test.skipIf(!serverTls)("prefer and require encrypt, and the server agrees", async () => {
    for (const sslmode of ["prefer", "require"] as const) {
      const c = await open({ sslmode });
      expect(c.encrypted).toBe(true);
      expect(await sslInUse(c)).toBe(true);
      // pipelining and prepared statements work the same over TLS
      expect((await c.query("select $1::int + 1 as n", [41])).rows[0]?.["n"]).toBe(42);
      c.close();
    }
  });

  test.skipIf(!serverTls || CA === "")("verify-full with the right CA and host name connects", async () => {
    const c = await open({ host: "localhost", sslmode: "verify-full", sslrootcert: CA });
    expect(await sslInUse(c)).toBe(true);
    c.close();
  });

  test.skipIf(!serverTls || CA === "")("verify-full checks the host name, verify-ca does not", async () => {
    // The test certificate names only "localhost", not 127.0.0.1.
    await expect(open({ host: "127.0.0.1", sslmode: "verify-full", sslrootcert: CA })).rejects.toThrow();
    const c = await open({ host: "127.0.0.1", sslmode: "verify-ca", sslrootcert: CA });
    expect(c.encrypted).toBe(true);
    c.close();
  });

  test.skipIf(!serverTls || OTHER_CA === "")("verification rejects a certificate from another CA, or with no CA given", async () => {
    await expect(open({ host: "localhost", sslmode: "verify-full", sslrootcert: OTHER_CA })).rejects.toThrow();
    await expect(open({ host: "localhost", sslmode: "verify-ca" })).rejects.toThrow();
  });

  test.skipIf(!serverTls)("a missing sslrootcert file is a clear error", async () => {
    await expect(open({ sslmode: "verify-full", sslrootcert: "/nope/ca.pem" })).rejects.toThrow(/Cannot read sslrootcert/);
  });
});
