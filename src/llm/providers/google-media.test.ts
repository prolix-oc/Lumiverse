import { afterAll, describe, expect, test } from "bun:test";
import { GoogleProvider } from "./google";
import { GoogleVertexProvider, stopVertexTokenSweep } from "./google-vertex";

afterAll(() => stopVertexTokenSweep());

for (const Provider of [GoogleProvider, GoogleVertexProvider]) {
  describe(`${Provider.name} input media resolution`, () => {
    const build = (parameters: Record<string, unknown>) => (new Provider() as any).buildBody({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: [{ type: "text", text: "Read the small text." },
        { type: "image", mime_type: "image/png", data: "PRIVATE_IMAGE_BYTES" },
        { type: "video", mime_type: "video/mp4", data: "PRIVATE_VIDEO_BYTES" }] }],
      parameters, tools: [],
    });

    test("maps optional flat settings into generationConfig alongside reasoning without changing media", () => {
      for (const [value, expected] of [["low", "LOW"], ["medium", "MEDIUM"], ["high", "HIGH"],
        ["unspecified", "UNSPECIFIED"], ["MEDIA_RESOLUTION_HIGH", "HIGH"]]) {
        const body = build({ media_resolution: value, max_tokens: 4000, thinkingConfig: { thinkingLevel: "HIGH" } });
        expect(body.generationConfig).toEqual({ mediaResolution: `MEDIA_RESOLUTION_${expected}`, maxOutputTokens: 4000, thinkingConfig: { thinkingLevel: "HIGH" } });
        expect(body).not.toHaveProperty("media_resolution");
        expect(body).not.toHaveProperty("mediaResolution");
        expect(body.contents[0].parts[1].inlineData.data).toBe("PRIVATE_IMAGE_BYTES");
        expect(body.contents[0].parts[2].inlineData.data).toBe("PRIVATE_VIDEO_BYTES");
      }
    });

    test("keeps provider defaults when omitted and accepts native camelCase settings", () => {
      expect(build({ max_tokens: 4000 }).generationConfig).not.toHaveProperty("mediaResolution");
      expect(build({ mediaResolution: "MEDIA_RESOLUTION_MEDIUM" }).generationConfig.mediaResolution).toBe("MEDIA_RESOLUTION_MEDIUM");
      expect(build({ media_resolution: "high", mediaResolution: "MEDIA_RESOLUTION_LOW" }).generationConfig.mediaResolution).toBe("MEDIA_RESOLUTION_HIGH");
      expect(build({ generationConfig: { mediaResolution: "MEDIA_RESOLUTION_HIGH" }, max_tokens: 4000 }).generationConfig)
        .toEqual({ mediaResolution: "MEDIA_RESOLUTION_HIGH", maxOutputTokens: 4000 });
    });

    test("rejects invalid and per-part-only levels before making an HTTP request", () => {
      for (const value of ["ultra_high", "MEDIA_RESOLUTION_ULTRA_HIGH", "unexpected", 42, {}]) {
        expect(() => build({ media_resolution: value })).toThrow("Gemini media_resolution must be");
      }
    });
  });
}
