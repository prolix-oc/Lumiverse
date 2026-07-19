import { describe, expect, test } from "bun:test";

import { normalizeDiskWarningSettings } from "./disk-warning-settings.service";

describe("normalizeDiskWarningSettings", () => {
  test("accepts whole-percent usage thresholds and normalizes to ratios", () => {
    expect(
      normalizeDiskWarningSettings({
        usagePercentThreshold: 92,
        minFreeBytesThreshold: 50 * 1024 * 1024 * 1024,
      }),
    ).toEqual({
      usagePercentThreshold: 0.92,
      minFreeBytesThreshold: 50 * 1024 * 1024 * 1024,
    });
  });

  test("accepts null values to clear stored overrides", () => {
    expect(
      normalizeDiskWarningSettings({
        usagePercentThreshold: null,
        minFreeBytesThreshold: null,
      }),
    ).toEqual({
      usagePercentThreshold: null,
      minFreeBytesThreshold: null,
    });
  });
});
