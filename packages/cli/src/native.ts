import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { CliError, LAYOUT, walk, writeIfChanged } from "./util";

const CLI_DIR = dirname(new URL(import.meta.url).pathname);
const PASSWORD_USE = /\b(hashPassword|verifyPassword)\b/;

/** The directory of @qala/core's C shims: next to the resolved package, or the monorepo sibling of this CLI. */
function coreNativeDir(root: string): string | null {
  const candidates: string[] = [];
  try {
    candidates.push(join(dirname(createRequire(join(root, "noop.js")).resolve("@qala/core/package.json")), "native"));
  } catch {
    // not resolvable from the app: fall back below
  }
  candidates.push(join(CLI_DIR, "..", "..", "core", "native"));
  return candidates.find((dir) => existsSync(join(dir, "password.ffi.json"))) ?? null;
}

/**
 * Extra scriptc arguments for apps that call hashPassword/verifyPassword: compiles @qala/core's libsodium shim into
 * `.qala/native/` and returns `--ffi <manifest>`. Apps that do not use password hashing need no C toolchain.
 */
export function nativeArgs(root: string): string[] {
  const used = walk(join(root, LAYOUT.app), (f) => f.endsWith(".ts")).some((file) => PASSWORD_USE.test(readFileSync(file, "utf8")));
  if (!used) return [];
  const source = coreNativeDir(root);
  if (source === null) throw new CliError("@qala/core's native/ directory was not found; cannot build password hashing");
  const out = join(root, LAYOUT.generated, "native");
  mkdirSync(out, { recursive: true });
  const cc = process.env.CC ?? "cc";
  const result = spawnSync(cc, ["-O2", "-c", join(source, "password.c"), "-o", join(out, "password.o")], { stdio: "inherit" });
  if (result.error !== undefined || result.status !== 0) {
    throw new CliError(`could not compile password hashing with \`${cc}\`: install a C compiler and libsodium headers (libsodium-dev / libsodium)`);
  }
  writeIfChanged(join(out, "password.ffi.json"), readFileSync(join(source, "password.ffi.json"), "utf8"));
  return ["--ffi", join(out, "password.ffi.json")];
}
