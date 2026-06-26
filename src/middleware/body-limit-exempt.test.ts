import { describe, expect, test } from "bun:test";
import { isLargeUploadBodyLimitExemptPath } from "./body-limit-exempt";

describe("isLargeUploadBodyLimitExemptPath", () => {
  test("allows the wallpaper upload endpoint through the global 10MB guard", () => {
    expect(isLargeUploadBodyLimitExemptPath("/api/v1/images/wallpapers")).toBe(true);
  });

  test("still rejects unrelated image routes", () => {
    expect(isLargeUploadBodyLimitExemptPath("/api/v1/images/rebuild-thumbnails")).toBe(false);
  });
});
