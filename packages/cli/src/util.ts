import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/** Paths of a Qala app, relative to its root. */
export const LAYOUT = {
  app: "app",
  controllers: "app/http/controllers",
  middleware: "app/http/middleware",
  domain: "app/domain",
  application: "app/application",
  infrastructure: "app/infrastructure",
  providers: "app/providers.ts",
  kernel: "app/kernel.ts",
  config: "config/app.ts",
  migrations: "database/migrations",
  generated: ".qala",
} as const;

export class CliError extends Error {}

/** The app root: the nearest directory (from `start` upwards) that has an `app/` folder or a qala-shaped package.json. */
export function findRoot(start: string = process.cwd()): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, LAYOUT.app)) && existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new CliError(`No Qala app found from ${start} upwards (expected an app/ folder next to package.json). Create one with: qala new <dir>`);
    dir = parent;
  }
}

/** Recursively lists files under `dir` (absolute paths), skipping node_modules and dot folders. */
export function walk(dir: string, filter: (file: string) => boolean = () => true): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

/** Writes only when the content changed (keeps `bun --watch` from restarting needlessly). Returns whether it wrote. */
export function writeIfChanged(file: string, content: string): boolean {
  if (existsSync(file) && readFileSync(file, "utf8") === content) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return true;
}

/** Creates a new file; refuses to overwrite unless `force`. */
export function createFile(root: string, path: string, content: string, force = false): string {
  const full = join(root, path);
  if (existsSync(full) && !force) throw new CliError(`${path} already exists (use --force to overwrite)`);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return path;
}

/** POSIX-style relative path. */
export function rel(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

/** Import specifier from `fromDir` to a .ts file, without the extension. */
export function importPath(fromDir: string, file: string): string {
  const r = rel(fromDir, file).replace(/\.ts$/, "");
  return r.startsWith(".") ? r : `./${r}`;
}

export function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== "")
    .map((w) => w.toLowerCase());
}
export const kebab = (name: string): string => words(name).join("-");
export const snake = (name: string): string => words(name).join("_");
export const pascal = (name: string): string => words(name).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
export const camel = (name: string): string => {
  const p = pascal(name);
  return p === "" ? p : p[0]!.toLowerCase() + p.slice(1);
};

/** Naive English singular/plural, good enough for resource names. */
export function singular(word: string): string {
  if (/ies$/i.test(word)) return word.slice(0, -3) + "y";
  if (/(ss|us)$/i.test(word)) return word;
  if (/(x|ch|sh|ses)$/i.test(word) && /es$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word)) return word.slice(0, -1);
  return word;
}
export function plural(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + "ies";
  if (/(s|x|ch|sh)$/i.test(word)) return word + "es";
  return word + "s";
}

const tty = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = { bold: paint(1), dim: paint(2), red: paint(31), green: paint(32), yellow: paint(33), blue: paint(34), cyan: paint(36), magenta: paint(35) };

/** Finds an executable in node_modules/.bin from `start` upwards. */
export function findBin(name: string, starts: string[]): string | null {
  for (const start of starts) {
    let dir = start;
    for (;;) {
      const candidate = join(dir, "node_modules", ".bin", name);
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
