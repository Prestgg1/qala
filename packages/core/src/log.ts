export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** A small structured logger: `pretty` for development, `json` (one object per line) for production. */
export class Logger {
  constructor(
    readonly level: LogLevel = "info",
    readonly format: "pretty" | "json" = "pretty",
    /** Fields added to every line of this logger (see `child`). */
    readonly fields: Record<string, unknown> = {},
  ) {}

  /** A logger with the same level and format that adds `fields` to every line, e.g. `{ request_id }`. */
  child(fields: Record<string, unknown>): Logger {
    const merged: Record<string, unknown> = {};
    for (const key of Object.keys(this.fields)) merged[key] = this.fields[key];
    for (const key of Object.keys(fields)) merged[key] = fields[key];
    return new Logger(this.level, this.format, merged);
  }

  debug(message: string, fields: Record<string, unknown> = {}): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields: Record<string, unknown> = {}): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields: Record<string, unknown> = {}): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields: Record<string, unknown> = {}): void {
    this.write("error", message, fields);
  }

  private write(level: LogLevel, message: string, own: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.level]) return;
    let fields = own;
    if (Object.keys(this.fields).length > 0) {
      fields = {};
      for (const key of Object.keys(this.fields)) fields[key] = this.fields[key];
      for (const key of Object.keys(own)) fields[key] = own[key];
    }
    let line: string;
    if (this.format === "json") {
      const record: Record<string, unknown> = { time: new Date().toISOString(), level, message };
      for (const key of Object.keys(fields)) record[key] = fields[key];
      line = JSON.stringify(record);
    } else {
      const parts: string[] = [];
      for (const key of Object.keys(fields)) {
        const v = fields[key];
        parts.push(`${key}=${typeof v === "string" ? v : JSON.stringify(v)}`);
      }
      line = `${new Date().toISOString().slice(11, 23)} ${level.toUpperCase().padEnd(5)} ${message}${parts.length > 0 ? `  ${parts.join(" ")}` : ""}`;
    }
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
  }
}
