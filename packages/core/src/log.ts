export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** A small structured logger: `pretty` for development, `json` (one object per line) for production. */
export class Logger {
  constructor(
    readonly level: LogLevel = "info",
    readonly format: "pretty" | "json" = "pretty",
  ) {}

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

  private write(level: LogLevel, message: string, fields: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.level]) return;
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
