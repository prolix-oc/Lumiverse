import { describe, expect, test } from "bun:test";

import { resolveImageProviderApiUrl, type ImageProvider } from "./provider";

function provider(defaultUrl: string): Pick<ImageProvider, "capabilities"> {
  return { capabilities: { defaultUrl } } as Pick<ImageProvider, "capabilities">;
}

describe("image provider endpoint resolution", () => {
  test("uses the configured URL when present", () => {
    expect(resolveImageProviderApiUrl("http://127.0.0.1:9000", provider("http://localhost:8188")))
      .toBe("http://127.0.0.1:9000");
  });

  test("falls back to the provider default when the connection omits api_url", () => {
    expect(resolveImageProviderApiUrl("", provider("http://localhost:8188")))
      .toBe("http://localhost:8188");
    expect(resolveImageProviderApiUrl("   ", provider("http://localhost:7860")))
      .toBe("http://localhost:7860");
    expect(resolveImageProviderApiUrl(null, provider("http://localhost:7801")))
      .toBe("http://localhost:7801");
  });

  test("returns an empty string when neither is available", () => {
    expect(resolveImageProviderApiUrl(undefined, provider(""))).toBe("");
  });
});
