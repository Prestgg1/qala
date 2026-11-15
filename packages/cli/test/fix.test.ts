import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fixApp } from "../src/fix";

const REPO = resolve(import.meta.dir, "../../..");
const CORE = join(REPO, "packages/core/src/index.ts");
const BIN = join(REPO, "packages/cli/src/bin.ts");
const TSC = join(REPO, "node_modules/.bin/tsc");
const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function app(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "qala-fix-"));
  temps.push(root);
  const all: Record<string, string> = {
    "package.json": '{ "name": "fixture", "private": true, "type": "module" }\n',
    "tsconfig.json": JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true, noUncheckedIndexedAccess: true, skipLibCheck: true, noEmit: true, types: ["node"], typeRoots: [join(REPO, "node_modules/@types")], paths: { "@qala/core": [CORE] } },
      include: ["app", "config"],
    }),
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");

describe("qala check --fix", () => {
  setDefaultTimeout(60_000);
  test("async override of an abstract method", () => {
    const root = app({
      "app/domain/repo.ts": "export abstract class Repo {\n  abstract find(id: string, limit?: number): Promise<string | null>;\n}\n",
      "app/infrastructure/pg.ts": 'import { Repo } from "../domain/repo";\nexport class Pg extends Repo {\n  /** docs */\n  async find(id: string, limit?: number): Promise<string | null> {\n    return id + String(limit);\n  }\n}\n',
    });
    const report = fixApp(root);
    expect(report.fixes.map((f) => `${f.file}:${f.line}`)).toEqual(["app/infrastructure/pg.ts:4"]);
    const out = read(root, "app/infrastructure/pg.ts");
    expect(out).toContain("find(id: string, limit?: number): Promise<string | null> { return this.findAsync(id, limit); }");
    expect(out).toContain("private async findAsync(id: string, limit?: number): Promise<string | null> {");
    expect(out).toContain("/** docs */");
    expect(fixApp(root).fixes).toEqual([]); // idempotent
  });

  test("a non-abstract async method is left alone", () => {
    const root = app({ "app/domain/a.ts": "export class A {\n  async f(): Promise<number> { return 1; }\n}\nexport class B extends A {\n  async f(): Promise<number> { return 2; }\n}\n" });
    expect(fixApp(root).fixes).toEqual([]);
  });

  test("DI calls with abstract tokens: type argument and union factory", () => {
    const root = app({
      "app/domain/mail.ts": "export abstract class Mailer { abstract send(): void; }\nexport class Smtp extends Mailer { send() {} }\nexport class Log extends Mailer { send() {} }\n",
      "app/providers.ts": [
        'import { singleton, transient, value } from "@qala/core";',
        'import { Log, Mailer, Smtp } from "./domain/mail";',
        "const prod = true;",
        "export const providers = [",
        "  singleton(Mailer, (c) => (prod ? new Smtp() : new Log())),",
        "  transient(Mailer, () => new Smtp()),",
        "  value(Mailer, new Log()),",
        "  singleton(Smtp, () => new Smtp()),",
        "];",
        "",
      ].join("\n"),
    });
    const report = fixApp(root);
    const out = read(root, "app/providers.ts");
    expect(out).toContain("singleton<Mailer>(Mailer, (c): Mailer => (prod ? new Smtp() : new Log())),");
    expect(out).toContain("transient<Mailer>(Mailer, () => new Smtp()),");
    expect(out).toContain("value<Mailer>(Mailer, new Log()),");
    expect(out).toContain("singleton(Smtp, () => new Smtp()),");
    expect(report.fixes.filter((f) => f.file === "app/providers.ts").map((f) => f.line)).toEqual([5, 5, 6, 7]);
    expect(fixApp(root).fixes).toEqual([]);
  });

  test("empty array literals in typed object slots", () => {
    const root = app({
      "app/domain/x.ts": "export type Page = { items: { id: string }[]; tags?: string[]; n: number };\nexport function page(): Page {\n  return { items: [], tags: [], n: 1 };\n}\nconst loose = { a: [] };\nexport { loose };\n",
    });
    fixApp(root);
    const out = read(root, "app/domain/x.ts");
    expect(out).toContain("{ items: [] as { id: string; }[], tags: [] as string[], n: 1 }");
    expect(out).toContain("const loose = { a: [] };");
  });

  test("default exports and imports become named (project files and packages)", () => {
    const root = app({
      "app/shared/util.ts": "export default function slug(s: string) { return s; }\n",
      "app/shared/box.ts": "class Box {}\nexport default Box;\n",
      "app/domain/use.ts": 'import slugify from "../shared/util";\nimport Box from "../shared/box";\nimport path from "node:path";\nexport const x = [slugify("a"), new Box(), path.join("a", "b"), path.sep];\n',
    });
    const report = fixApp(root);
    expect(read(root, "app/shared/util.ts")).toBe("export function slug(s: string) { return s; }\n");
    expect(read(root, "app/shared/box.ts")).toBe("class Box {}\nexport { Box };\n");
    const use = read(root, "app/domain/use.ts");
    expect(use).toContain('import { slug as slugify } from "../shared/util";');
    expect(use).toContain('import { Box } from "../shared/box";');
    expect(use).toContain('import { join, sep } from "node:path";');
    expect(use).toContain("path.join".replace("path.", "") + '("a", "b"), sep]');
    expect(report.unfixable).toEqual([]);
    expect(spawnSync(TSC, ["-p", join(root, "tsconfig.json")], { encoding: "utf8" }).stdout.trim()).toBe("");
  });

  test("anonymous default exports are reported, not rewritten", () => {
    const root = app({ "app/shared/a.ts": "export default function () { return 1; }\n" });
    const report = fixApp(root);
    expect(report.fixes).toEqual([]);
    expect(report.unfixable[0]!.message).toContain("anonymous default export");
  });

  test("export * from a package lists the names", () => {
    const root = app({
      "app/shared/re.ts": 'export * from "dep";\n',
      "node_modules/dep/package.json": '{ "name": "dep", "version": "1.0.0", "types": "index.d.ts" }',
      "node_modules/dep/index.d.ts": "export declare function join(a: string): string;\nexport declare const sep: string;\nexport type Part = { a: string };\nexport default function d(): void;\n",
    });
    fixApp(root);
    const out = read(root, "app/shared/re.ts");
    expect(out).toBe('export { join, sep } from "dep";\nexport type { Part } from "dep";\n');
    expect(out).not.toContain("export *");
  });

  test("bin: qala check --fix prints file:line and then runs the architecture check", () => {
    const root = app({
      "app/domain/repo.ts": "export abstract class Repo { abstract f(): Promise<number>; }\n",
      "app/infrastructure/pg.ts": 'import { Repo } from "../domain/repo";\nexport class Pg extends Repo {\n  async f(): Promise<number> { return 1; }\n}\n',
    });
    const run = spawnSync(process.execPath, [BIN, "check", "--fix"], { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("fixed app/infrastructure/pg.ts:3");
    expect(run.stdout).toContain("follow the dependency rule");
  });
});
