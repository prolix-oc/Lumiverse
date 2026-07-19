import { describe, expect, test } from "bun:test";

import {
  shouldWarnForDiskUsage,
  type DiskWarningThresholds,
} from "./disk-monitor.service";

const GIB = 1024 * 1024 * 1024;

const thresholds: DiskWarningThresholds = {
  usagePercentThreshold: 0.9,
  minFreeBytesThreshold: 100 * GIB,
};

describe("shouldWarnForDiskUsage", () => {
  test("suppresses warnings on large disks with ample free space", () => {
    expect(
      shouldWarnForDiskUsage(
        { usagePercent: 0.92, freeBytes: 500 * GIB },
        thresholds,
      ),
    ).toBe(false);
  });

  test("warns once both the usage and free-space thresholds are crossed", () => {
    expect(
      shouldWarnForDiskUsage(
        { usagePercent: 0.95, freeBytes: 80 * GIB },
        thresholds,
      ),
    ).toBe(true);
  });

  test("does not warn when usage has not crossed the usage threshold", () => {
    expect(
      shouldWarnForDiskUsage(
        { usagePercent: 0.82, freeBytes: 80 * GIB },
        thresholds,
      ),
    ).toBe(false);
  });
});
