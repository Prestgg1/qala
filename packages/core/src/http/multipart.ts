import { HttpError } from "../errors";

/** One file part of a multipart/form-data body. */
export class UploadedFile {
  constructor(
    /** The form field name. */
    readonly field: string,
    readonly filename: string,
    /** The part's content type (`application/octet-stream` when the client sent none). */
    readonly contentType: string,
    readonly data: Uint8Array,
    /** Size in bytes (`data.length`). */
    readonly size: number,
  ) {}

  /** The file decoded as UTF-8 text (only meaningful for text files). */
  text(): string {
    return decodeUtf8(this.data);
  }
}

/** The parsed form: text fields (the last value wins for repeated names) and uploaded files in order. */
export class MultipartForm {
  constructor(
    readonly fields: Record<string, string>,
    readonly files: UploadedFile[],
  ) {}
}

/** Limits for one multipart body (0 = unlimited; the server's `bodyLimit` still caps the whole request). */
export class MultipartLimits {
  constructor(
    readonly maxFileSize: number,
    readonly maxFiles: number,
  ) {}
}

/** Decodes bytes as UTF-8 (invalid sequences become U+FFFD). */
export function decodeUtf8(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  return Buffer.from(bytes).toString("utf8");
}

/** Whether a content-type header is `multipart/form-data`. */
export function isMultipart(contentType: string): boolean {
  return contentType.trim().toLowerCase().startsWith("multipart/form-data");
}

/** The boundary parameter of a multipart content type, quoted or not; `null` if missing or invalid. */
export function multipartBoundary(contentType: string): string | null {
  if (!isMultipart(contentType)) return null;
  const parts = contentType.split(";");
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!.trim();
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim().toLowerCase() !== "boundary") continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value === "" || value.length > 70) return null;
    return value;
  }
  return null;
}

function bad(message: string): HttpError {
  return new HttpError(400, message, "invalid_multipart");
}

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Index of `needle` in `hay` at or after `from`, or -1. */
function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from: number): number {
  const n = needle.length;
  const first = needle[0]!;
  const last = hay.length - n;
  for (let i = from; i <= last; i++) {
    if (hay[i] !== first) continue;
    let j = 1;
    while (j < n && hay[i + j] === needle[j]) j++;
    if (j === n) return i;
  }
  return -1;
}

/** `name="value"` (or unquoted) parameter of a header value such as `form-data; name="a"; filename="b.png"`. */
function headerParam(value: string, name: string): string | null {
  const lower = value.toLowerCase();
  let at = 0;
  while (at < lower.length) {
    const found = lower.indexOf(name + "=", at);
    if (found === -1) return null;
    // Must start a parameter, not be the tail of another one (e.g. `filename=` when looking for `name=`).
    let p = found - 1;
    while (p >= 0 && lower[p] === " ") p--;
    if (found === 0 || p < 0 || lower[p] === ";") {
      let i = found + name.length + 1;
      if (value[i] === '"') {
        let out = "";
        i++;
        while (i < value.length && value[i] !== '"') {
          if (value[i] === "\\" && i + 1 < value.length) i++;
          out += value[i];
          i++;
        }
        return out;
      }
      const end = value.indexOf(";", i);
      return value.slice(i, end === -1 ? value.length : end).trim();
    }
    at = found + 1;
  }
  return null;
}

/**
 * Parses a multipart/form-data body. Throws `HttpError` 400 (`invalid_multipart`) for a missing/bad boundary or
 * malformed parts, 413 for a file over `limits.maxFileSize`. Files are copies (not views of `raw`).
 */
export function parseMultipart(contentType: string, raw: Uint8Array, limits: MultipartLimits = new MultipartLimits(0, 0)): MultipartForm {
  const boundary = multipartBoundary(contentType);
  if (boundary === null) throw bad("multipart/form-data needs a boundary");
  const delimiter = ascii("--" + boundary);
  const separator = ascii("\r\n--" + boundary);
  const fields: Record<string, string> = {};
  const files: UploadedFile[] = [];

  // The body starts with the delimiter (a preamble before it is ignored).
  let pos = indexOfBytes(raw, delimiter, 0);
  if (pos === -1) throw bad("multipart body does not contain the boundary");
  pos += delimiter.length;
  let closed = false;
  while (!closed) {
    // After a delimiter: `--` ends the body, otherwise (optional spaces and) CRLF starts a part.
    if (raw[pos] === 0x2d && raw[pos + 1] === 0x2d) {
      closed = true;
      break;
    }
    while (raw[pos] === 0x20 || raw[pos] === 0x09) pos++;
    if (raw[pos] !== 0x0d || raw[pos + 1] !== 0x0a) throw bad("malformed multipart boundary line");
    pos += 2;
    // Headers end at the first blank line.
    const headerEnd = indexOfBytes(raw, ascii("\r\n\r\n"), pos - 2);
    if (headerEnd === -1) throw bad("multipart part has no header terminator");
    const headerText = headerEnd < pos ? "" : decodeUtf8(raw.subarray(pos, headerEnd));
    const dataStart = headerEnd + 4;
    const next = indexOfBytes(raw, separator, dataStart - 2 < pos ? pos : dataStart - 2);
    if (next === -1 || next + 2 < dataStart) throw bad("multipart body is not terminated");
    const dataEnd = next < dataStart ? dataStart : next;

    let disposition = "";
    let partType = "";
    for (const line of headerText.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim().toLowerCase();
      if (key === "content-disposition") disposition = line.slice(colon + 1).trim();
      else if (key === "content-type") partType = line.slice(colon + 1).trim();
    }
    const field = headerParam(disposition, "name");
    if (field === null) throw bad("multipart part has no field name");
    const filename = headerParam(disposition, "filename");
    if (filename === null) {
      fields[field] = decodeUtf8(raw.subarray(dataStart, dataEnd));
    } else {
      const size = dataEnd - dataStart;
      if (limits.maxFileSize > 0 && size > limits.maxFileSize) {
        throw new HttpError(413, `File "${filename}" is larger than ${limits.maxFileSize} bytes`, "payload_too_large");
      }
      if (limits.maxFiles > 0 && files.length >= limits.maxFiles) throw bad(`At most ${limits.maxFiles} files are accepted`);
      files.push(new UploadedFile(field, filename, partType === "" ? "application/octet-stream" : partType, raw.slice(dataStart, dataEnd), size));
    }
    pos = next + separator.length;
  }
  return new MultipartForm(fields, files);
}
