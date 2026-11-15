import { describe, expect, test } from "bun:test";
import { runScenario } from "./fuzz";

describe("differential fuzzing against Yjs 13.6.33", () => {
  const kinds = ["qyq", "yqy", "qqy", "yyq", "qqq"];
  test("300 fixed-seed scenarios converge (state vectors, XML + text deltas, maps, re-encoded state)", () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 300; seed++) {
      const r = runScenario(seed, 40, kinds[seed % kinds.length]!);
      if (!r.ok) failures.push(`seed ${seed}: ${r.detail.slice(0, 600)}`);
    }
    expect(failures).toEqual([]);
  }, 120000);
});
