/**
 * Publishes every @qala/* package whose version is not on npm yet, with `bun publish` (which rewrites
 * `workspace:*` ranges to real versions), printing a `New tag:` line per package for changesets/action.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const published: string[] = [];
for (const dir of readdirSync(join(root, "packages"))) {
  const pkgDir = join(root, "packages", dir);
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { name: string; version: string; private?: boolean };
  if (pkg.private === true) continue;
  const res = await fetch(`https://registry.npmjs.org/${pkg.name.replace("/", "%2f")}/${pkg.version}`);
  if (res.status === 200) {
    console.log(`skip ${pkg.name}@${pkg.version} (already published)`);
    continue;
  }
  const run = Bun.spawnSync(["bun", "publish", "--access", "public"], { cwd: pkgDir, stdio: ["inherit", "inherit", "inherit"] });
  if (run.exitCode !== 0) process.exit(run.exitCode ?? 1);
  published.push(`${pkg.name}@${pkg.version}`);
  // changesets/action reads these lines to create the GitHub releases.
  console.log(`New tag: ${pkg.name}@${pkg.version}`);
}
console.log(`${published.length} package(s) published`);
