import { describe, expect, test } from "bun:test";
import { deserializeWorkerResponseError } from "./worker-response-error";

describe("worker response errors", () => {
  test("preserves preset revision conflict metadata for extension recovery", () => {
    const error = deserializeWorkerResponseError({
      code: "PRESET_REVISION_CONFLICT",
      message: "Preset changed",
      presetId: "preset-1",
      expectedCacheRevision: 3,
      actualCacheRevision: 4,
    });

    expect(error.message).toBe("Preset changed");
    expect(error).toMatchObject({
      code: "PRESET_REVISION_CONFLICT",
      presetId: "preset-1",
      expectedCacheRevision: 3,
      actualCacheRevision: 4,
    });
  });
});
