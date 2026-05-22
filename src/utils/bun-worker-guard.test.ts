import { describe, expect, test } from "bun:test";

import { shouldUseBunWorkers } from "./bun-worker-guard";

describe("shouldUseBunWorkers", () => {
  test("disables Bun workers on Windows by default", () => {
    expect(shouldUseBunWorkers("win32", {})).toBe(false);
  });

  test("allows an explicit Windows override", () => {
    expect(shouldUseBunWorkers("win32", { LUMIVERSE_FORCE_BUN_WORKERS: "1" })).toBe(true);
  });

  test("keeps Bun workers enabled on non-Windows platforms", () => {
    expect(shouldUseBunWorkers("linux", {})).toBe(true);
  });
});
