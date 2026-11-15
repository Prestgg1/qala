import { describe, expect, test } from "bun:test";
import { isWorker, resolveWorkers, WORKER_ENV } from "@qala/core";

describe("cluster", () => {
  test("resolveWorkers defaults to one process", () => {
    expect(resolveWorkers(undefined)).toBe(1);
    expect(resolveWorkers(0)).toBe(1);
    expect(resolveWorkers(-3)).toBe(1);
    expect(resolveWorkers(3)).toBe(3);
    expect(resolveWorkers(2.9)).toBe(2);
  });

  test('"auto" uses one process per CPU', () => {
    expect(resolveWorkers("auto")).toBeGreaterThanOrEqual(1);
  });

  test("the primary process is not a worker", () => {
    expect(process.env[WORKER_ENV]).toBeUndefined();
    expect(isWorker()).toBe(false);
  });
});
