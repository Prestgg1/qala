import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanModels } from "../src/models";

test("model decoders understand column modifiers", () => {
  const root = mkdtempSync(join(tmpdir(), "qala-mod-"));
  mkdirSync(join(root, "app/domain"), { recursive: true });
  writeFileSync(
    join(root, "app/domain/task.ts"),
    `import { model, t } from "@qala/core";
export const Task = model("tasks", {
  id: t.uuid().primary(),
  done: t.boolean().default(false),
  priority: t.integer().default(0).index(),
  note: t.string().nullable(),
  parentId: t.uuid().nullable().referencesSelf(),
  createdAt: t.datetime().now(),
});
`,
  );
  const { models, skipped } = scanModels(root);
  expect(skipped).toEqual([]);
  expect(models[0]!.fields.map((f) => [f.name, f.kind, f.nullable])).toEqual([
    ["id", "text", false],
    ["done", "boolean", false],
    ["priority", "number", false],
    ["note", "text", true],
    ["parentId", "text", true],
    ["createdAt", "datetime", false],
  ]);
});
