import { HttpError } from "../errors";
import type { Context } from "./context";
import { isMultipart, parseMultipart, type MultipartLimits, type UploadedFile } from "./multipart";

/** What a request body turned into: the value to validate and the uploaded files. */
export class ParsedBody {
  constructor(
    readonly value: unknown,
    readonly files: UploadedFile[],
    /** Whether the value came from multipart text fields (strings, so the schema coerces them). */
    readonly form: boolean,
  ) {}
}

/** Reads the request body: JSON as before, multipart/form-data when the action accepts uploads, else 415. */
export function readBody(ctx: Context, multipart: MultipartLimits | null): ParsedBody {
  const type = ctx.header("content-type") ?? "";
  if (multipart !== null && isMultipart(type)) {
    const form = parseMultipart(type, ctx.request.raw, multipart);
    return new ParsedBody(form.fields, form.files, true);
  }
  if (ctx.request.empty) return new ParsedBody(undefined, [], false);
  if (type !== "" && !type.includes("json")) throw new HttpError(415, "Expected a JSON body (content-type: application/json)", "unsupported_media_type");
  try {
    return new ParsedBody(JSON.parse(ctx.request.body) as unknown, [], false);
  } catch {
    throw new HttpError(400, "The body is not valid JSON", "invalid_json");
  }
}
