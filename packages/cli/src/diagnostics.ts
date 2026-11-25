import type { Violation } from "./check";
import type { CheckResult } from "./doctor";
import type { FixReport } from "./fix";
import type { RouteRow } from "./scan";

/** Bumped only on a breaking change to any `--json` shape (fields are only ever added within a version). */
export const JSON_VERSION = 1;

export const DOCS = "https://prestgg1.github.io/qala";

/** Every stable diagnostic code: what it means and how to fix it. Documented in docs/guide/check.md. */
export const CODES: Record<string, { title: string; fix: string; docs: string }> = {
  QALA101: {
    title: "layer imports a layer it must not depend on",
    fix: "Depend on an abstract class in app/domain instead and let infrastructure extend it (constructor injection wires it), or move the code to a layer allowed to import the target.",
    docs: `${DOCS}/guide/project-layout`,
  },
  QALA102: {
    title: "layer imports a package it must not use",
    fix: "Wrap the package in a class under app/infrastructure that extends an abstract class from app/domain; inject the abstract class where you need it.",
    docs: `${DOCS}/guide/project-layout`,
  },
  QALA103: {
    title: "layer imports a composition root",
    fix: "Do not import app/providers.ts, app/kernel.ts, app/auth.ts, app/events/ or config/ from a layer; take what you need as a constructor parameter.",
    docs: `${DOCS}/guide/dependency-injection`,
  },
  QALA104: {
    title: "import of a project file outside the layers",
    fix: "Move the imported file under app/domain, app/application, app/infrastructure, app/http or app/shared.",
    docs: `${DOCS}/guide/project-layout`,
  },
  QALA105: {
    title: "compiled queries used outside app/infrastructure",
    fix: "Call the compiled query from a repository in app/infrastructure and inject the repository's abstract class.",
    docs: `${DOCS}/guide/queries`,
  },
  QALA106: {
    title: "a .query.ts declaration imported at run time",
    fix: "Import the compiled query from .qala/queries.gen (run qala generate) instead of the .query.ts file.",
    docs: `${DOCS}/guide/queries`,
  },
  QALA201: {
    title: "async method overrides an abstract method (scriptc)",
    fix: "Run qala check --fix, or make the override non-async and return the promise of a private async helper.",
    docs: `${DOCS}/guide/native`,
  },
  QALA202: {
    title: "abstract DI token without an explicit type argument (scriptc)",
    fix: "Run qala check --fix, or write singleton<X>(X, ...).",
    docs: `${DOCS}/guide/native`,
  },
  QALA203: {
    title: "provider factory returns a union (scriptc)",
    fix: "Run qala check --fix, or annotate the factory's return type with the abstract type.",
    docs: `${DOCS}/guide/native`,
  },
  QALA204: {
    title: "untyped empty array literal (scriptc)",
    fix: "Run qala check --fix, or write [] as T[].",
    docs: `${DOCS}/guide/native`,
  },
  QALA205: {
    title: "default export (scriptc)",
    fix: "Run qala check --fix, or export the declaration by name. Anonymous defaults need a name first.",
    docs: `${DOCS}/guide/native`,
  },
  QALA206: {
    title: "default import (scriptc)",
    fix: "Run qala check --fix, or use named imports: import { join } from \"node:path\".",
    docs: `${DOCS}/guide/native`,
  },
  QALA207: {
    title: "export * from a package (scriptc)",
    fix: "Run qala check --fix, or list the package's exports by name.",
    docs: `${DOCS}/guide/native`,
  },
};

export type Diagnostic = { code: string; severity: "error" | "warning"; file: string; line: number; column: number; message: string; fix: string; docs: string };

function diagnostic(code: string, severity: Diagnostic["severity"], d: { file: string; line: number; column: number; message: string }): Diagnostic {
  const info = CODES[code];
  return { code, severity, file: d.file, line: d.line, column: d.column, message: d.message, fix: info?.fix ?? "", docs: info?.docs ?? `${DOCS}/guide/check` };
}

/** The `qala check --json` document. */
export type CheckJson = {
  version: number;
  ok: boolean;
  files: number;
  diagnostics: Diagnostic[];
  fixed: { code: string; file: string; line: number; column: number; message: string }[];
};

export function checkJson(files: number, violations: Violation[], report: FixReport | null): CheckJson {
  const diagnostics = violations.map((v) => diagnostic(v.code, "error", v));
  if (report !== null) for (const u of report.unfixable) diagnostics.push(diagnostic(u.code, "warning", u));
  return {
    version: JSON_VERSION,
    ok: violations.length === 0,
    files,
    diagnostics,
    fixed: (report?.fixes ?? []).map((f) => ({ code: f.code, file: f.file, line: f.line, column: f.column, message: f.message })),
  };
}

/** The `qala routes --json` document. */
export type RoutesJson = { version: number; routes: { method: string; path: string; controller: string; action: string; file: string; line: number }[] };

export function routesJson(rows: RouteRow[]): RoutesJson {
  return {
    version: JSON_VERSION,
    routes: rows.map((r) => {
      const colon = r.file.lastIndexOf(":");
      return { method: r.method, path: r.path, controller: r.controller, action: r.action, file: r.file.slice(0, colon), line: Number(r.file.slice(colon + 1)) };
    }),
  };
}

/** The `qala doctor --json` document. */
export type DoctorJson = { version: number; ok: boolean; checks: CheckResult[] };

export function doctorJson(results: CheckResult[]): DoctorJson {
  return { version: JSON_VERSION, ok: !results.some((r) => r.status === "fail"), checks: results };
}

/** Human output for violations: `file:line  message [CODE]`, then one fix hint per code. */
export function printViolations(violations: Violation[], color: { red(s: string): string; dim(s: string): string }): void {
  for (const v of violations) console.error(`${color.red("✗")} ${v.file}:${v.line}  ${v.message} [${v.code}]`);
  for (const code of [...new Set(violations.map((v) => v.code))]) {
    const info = CODES[code];
    if (info !== undefined) console.error(color.dim(`  ${code} fix: ${info.fix} (${info.docs})`));
  }
}

/** What every command prints with `--json` when it fails before producing its document. */
export function errorJson(message: string): { version: number; ok: false; error: { message: string } } {
  return { version: JSON_VERSION, ok: false, error: { message } };
}
