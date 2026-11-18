import { describe, expect, test } from "bun:test";
import { checkRuntime, versionAtLeast } from "../src/doctor";

describe("versionAtLeast", () => {
  test("compares numerically", () => {
    expect(versionAtLeast("1.10.0", "1.9.3")).toBe(true);
    expect(versionAtLeast("v24.1.0", "24.0.0")).toBe(true);
    expect(versionAtLeast("1.2.9", "1.3.0")).toBe(false);
    expect(versionAtLeast("1.3.0-canary.1", "1.3.0")).toBe(true);
  });
});

describe("checkRuntime", () => {
  test("all good", () => {
    expect(checkRuntime("1.3.2", "v24.2.0", "linux").every((r) => r.status === "ok")).toBe(true);
  });
  test("old Bun fails, missing Node warns, Windows fails", () => {
    const [bun, node, platform] = checkRuntime("1.2.0", undefined, "win32");
    expect(bun!.status).toBe("fail");
    expect(node!.status).toBe("warn");
    expect(platform!.status).toBe("fail");
  });
});
