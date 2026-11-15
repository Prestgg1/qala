import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { routeTable, scanControllers } from "../src/scan";

function app(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "qala-res-scan-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe("resource() controllers", () => {
  test("conventional routes, only/except, scope prefix and extra actions", () => {
    const root = app({
      "app/http/controllers/labels.controller.ts": `import { post, resource } from "@qala/core";
import { Label } from "../../domain/label";
export const LabelsController = resource(Label, { scope: "projects/:projectId", except: ["destroy"] }, ({ table }) => ({
  archive: post("/:id/archive", {}, ({ id }) => table.update(id, { archived: true })),
}));
`,
      "app/http/controllers/boards.controller.ts": `import { resource } from "@qala/core";
import { Board } from "../../domain/board";
export const BoardsController = resource(Board, { only: ["index", "show"] });
`,
      "app/http/controllers/(auth)/tags.controller.ts": `import { resource } from "@qala/core";
import { Tag } from "../../../domain/tag";
export const TagsController = resource(Tag);
`,
    });
    const rows = routeTable(scanControllers(root)).map((r) => `${r.method} ${r.path} ${r.controller}.${r.action}`);
    expect(rows.sort()).toEqual(
      [
        "GET /boards boards.index",
        "GET /boards/:id boards.show",
        "GET /projects/:projectId/labels labels.index",
        "GET /projects/:projectId/labels/:id labels.show",
        "POST /projects/:projectId/labels labels.store",
        "PATCH /projects/:projectId/labels/:id labels.update",
        "POST /projects/:projectId/labels/:id/archive labels.archive",
        "GET /tags tags.index",
        "GET /tags/:id tags.show",
        "POST /tags tags.store",
        "PATCH /tags/:id tags.update",
        "DELETE /tags/:id tags.destroy",
      ].sort(),
    );
    expect(scanControllers(root).find((c) => c.name === "tags")?.auth).toBe(true);
  });

  test("options must be readable at build time", () => {
    const root = app({
      "app/http/controllers/labels.controller.ts": `import { resource } from "@qala/core";
import { Label } from "../../domain/label";
const opts = { only: ["index"] as const };
export const LabelsController = resource(Label, opts);
`,
    });
    expect(() => scanControllers(root)).toThrow(/options must be an object literal/);
  });
});
