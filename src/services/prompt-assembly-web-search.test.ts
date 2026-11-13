import { describe, expect, test } from "bun:test";

import { applyGoogleSearchPresetSetting } from "./prompt-assembly.service";

describe("applyGoogleSearchPresetSetting", () => {
  test.each(["google", "google_vertex"])(
    "maps the preset checkbox for %s",
    (provider) => {
      const params: Record<string, unknown> = {};
      applyGoogleSearchPresetSetting(params, true, provider);
      expect(params.enable_web_search).toBe(true);
    },
  );

  test("does not leak the Google-only parameter to other providers", () => {
    const params: Record<string, unknown> = {};
    applyGoogleSearchPresetSetting(params, true, "anthropic");
    expect(params.enable_web_search).toBeUndefined();
  });

  test("does nothing when the checkbox is off", () => {
    const params: Record<string, unknown> = {};
    applyGoogleSearchPresetSetting(params, false, "google");
    expect(params.enable_web_search).toBeUndefined();
  });
});
