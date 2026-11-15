/** Attributes of a `Set-Cookie` header. */
export type CookieOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "strict" | "lax" | "none";
  path?: string;
  domain?: string;
  /** Lifetime in seconds. */
  maxAge?: number;
  expires?: Date;
};

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Parses a `Cookie` request header into name → value (values are percent-decoded, the first occurrence wins). */
export function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === "") return out;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (name === "" || name in out) continue;
    let value = pair.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out[name] = decode(value);
  }
  return out;
}

/** Builds the value of a `Set-Cookie` header. The value is percent-encoded. */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (name === "" || /[^A-Za-z0-9!#$%&'*+.^_`|~-]/.test(name)) throw new Error(`Invalid cookie name: ${name}`);
  let out = `${name}=${encodeURIComponent(value)}`;
  out += `; Path=${options.path ?? "/"}`;
  if (options.domain !== undefined) out += `; Domain=${options.domain}`;
  if (options.maxAge !== undefined) out += `; Max-Age=${Math.floor(options.maxAge)}`;
  if (options.expires !== undefined) out += `; Expires=${options.expires.toUTCString()}`;
  if (options.httpOnly === true) out += "; HttpOnly";
  if (options.secure === true) out += "; Secure";
  if (options.sameSite !== undefined) out += `; SameSite=${options.sameSite === "strict" ? "Strict" : options.sameSite === "lax" ? "Lax" : "None"}`;
  return out;
}
