import { describe, expect, test } from "bun:test";
import type { ImageGenConnectionProfile } from "../../../../types/image-gen-connection";
import type { WeaverVisualAsset } from "../../../../types/weaver";
import { getVisualProviderAdapter } from "../provider-registry";
import { adapterImageInput } from "../provider-adapter";

const connection: ImageGenConnectionProfile = {
  id: "openrouter-connection",
  name: "OpenRouter",
  provider: "openrouter",
  api_url: "https://openrouter.ai/api/v1",
  model: "google/gemini-2.5-flash-image",
  is_default: false,
  has_api_key: true,
  default_parameters: { imageSize: "2K" },
  metadata: {},
  created_at: 1,
  updated_at: 1,
};

const asset: WeaverVisualAsset = {
  kind: "expressions",
  prompt: "a cheerful expression",
  negative_prompt: "blurry",
  width: 832,
  height: 1216,
  aspect_ratio: "2:3",
  seed: null,
  provider: "openrouter",
  provider_state: { params: { strength: 0.35, unsupportedParameter: true } },
  source_image: { data: "QUJD", mimeType: "image/jpeg" },
};

describe("OpenRouter Weaver visual adapter", () => {
  test("is registered as an image-editing provider", () => {
    const adapter = getVisualProviderAdapter("openrouter");

    expect(adapter?.provider).toBe("openrouter");
    expect(adapter?.imageInput).toBe("edit");
  });

  test("maps aspect ratio and source images into OpenRouter parameters", async () => {
    const adapter = getVisualProviderAdapter("openrouter");
    if (!adapter) throw new Error("OpenRouter visual adapter is not registered");

    const result = await adapter.build(asset, connection);

    expect(result.request).toEqual({
      prompt: "a cheerful expression",
      negativePrompt: "blurry",
      model: "google/gemini-2.5-flash-image",
      parameters: {
        imageSize: "2K",
        strength: 0.35,
        aspectRatio: "2:3",
        resolvedSourceImages: [{ data: "QUJD", mimeType: "image/jpeg" }],
      },
    });
    expect(result.settingsSnapshot).toEqual({
      provider: "openrouter",
      model: "google/gemini-2.5-flash-image",
      parameters: {
        imageSize: "2K",
        strength: 0.35,
        aspectRatio: "2:3",
        resolvedSourceImages: "[source image]",
      },
    });
  });
});

describe("NovelAI V5 Weaver visual adapter", () => {
  const novelAIConnection: ImageGenConnectionProfile = {
    ...connection,
    id: "novelai-v5-connection",
    name: "NovelAI V5",
    provider: "novelai",
    api_url: "https://image.novelai.net",
    model: "nai-diffusion-5-full",
  };
  const novelAIAsset: WeaverVisualAsset = {
    ...asset,
    provider: "novelai",
  };

  test("reports V5 reference input as unavailable", async () => {
    const adapter = getVisualProviderAdapter("novelai");
    if (!adapter) throw new Error("NovelAI visual adapter is not registered");

    expect(adapterImageInput(adapter, novelAIConnection)).toEqual({
      supported: false,
      mechanism: null,
      reason: "NovelAI V5 does not currently support Vibe Transfer or Precise Reference.",
    });
    await expect(adapter.validate(novelAIAsset, novelAIConnection)).resolves.toContain(
      "NovelAI V5 does not currently support Vibe Transfer or Precise Reference.",
    );
  });
});
