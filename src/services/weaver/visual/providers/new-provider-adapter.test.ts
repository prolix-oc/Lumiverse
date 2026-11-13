import { describe, expect, test } from "bun:test";
import type { ImageGenConnectionProfile } from "../../../../types/image-gen-connection";
import type { WeaverVisualAsset, WeaverVisualProvider } from "../../../../types/weaver";
import { getVisualProviderAdapter } from "../provider-registry";
import { adapterImageInput } from "../provider-adapter";

function connection(provider: string, model: string): ImageGenConnectionProfile {
  return {
    id: `${provider}-connection`,
    name: provider,
    provider,
    api_url: "https://example.test",
    model,
    is_default: false,
    has_api_key: true,
    default_parameters: {},
    metadata: {},
    created_at: 1,
    updated_at: 1,
  };
}

function asset(provider: WeaverVisualProvider, extra: Partial<WeaverVisualAsset> = {}): WeaverVisualAsset {
  return {
    kind: "scenes",
    prompt: "a quiet harbour at dawn",
    negative_prompt: "",
    width: 1216,
    height: 832,
    aspect_ratio: "3:2",
    seed: 12,
    provider,
    provider_state: {},
    ...extra,
  };
}

const EDIT_PROVIDERS: WeaverVisualProvider[] = ["openai", "xai", "ideogram", "bfl", "fal", "together", "stability", "runware"];
const NON_IMAGE_PROVIDERS: WeaverVisualProvider[] = [
  "pollinations",
  "deepinfra",
  "venice",
  "venice_compat",
  "recraft",
  "fireworks",
  "replicate",
  "leonardo",
  "civitai",
  "civitai_chat",
  "huggingface",
  "custom_openai",
];

describe("New provider visual adapters", () => {
  test.each(EDIT_PROVIDERS)("%s is registered and accepts a source image as an edit", (provider) => {
    const adapter = getVisualProviderAdapter(provider);
    if (!adapter) throw new Error(`${provider} adapter missing`);
    expect(adapterImageInput(adapter, connection(provider, provider === "ideogram" ? "ideogram-4-5" : "model")).supported).toBe(true);
  });

  test.each(NON_IMAGE_PROVIDERS)("%s is registered without image input", (provider) => {
    const adapter = getVisualProviderAdapter(provider);
    if (!adapter) throw new Error(`${provider} adapter missing`);
    expect(adapter.imageInput).toBeNull();
    expect(adapterImageInput(adapter, connection(provider, "model")).supported).toBe(false);
  });

  test.each([
    ["stability", "core"], ["ideogram", "ideogram-2a"], ["fal", "fal-ai/flux/dev"],
  ] as const)("%s rejects source images for the text-only model %s", async (provider, model) => {
    const adapter = getVisualProviderAdapter(provider)!;
    const profile = connection(provider, model);
    const input = asset(provider, { source_image: { data: "QUJD", mimeType: "image/png" } });
    expect(adapterImageInput(adapter, profile).supported).toBe(false);
    expect(await adapter.validate(input, profile)).not.toBeEmpty();
    await expect(adapter.build(input, profile)).rejects.toThrow(/source image|image as input/);
  });

  test("text-only providers reject a source instead of silently discarding it", async () => {
    const adapter = getVisualProviderAdapter("replicate")!;
    const input = asset("replicate", { source_image: { data: "QUJD", mimeType: "image/png" } });
    await expect(adapter.build(input, connection("replicate", "model"))).rejects.toThrow(/image as input/);
  });

  test("xAI maps the scene size onto aspect_ratio, not width/height", async () => {
    const adapter = getVisualProviderAdapter("xai")!;
    const result = await adapter.build(asset("xai", { source_image: { data: "QUJD", mimeType: "image/png" } }), connection("xai", "grok-imagine-image-2.0"));

    expect(result.request.parameters.aspectRatio).toBe("3:2");
    expect(result.request.parameters.size).toBeUndefined();
    expect(result.request.parameters.width).toBeUndefined();
    expect(result.request.parameters.resolvedSourceImages).toEqual([{ data: "QUJD", mimeType: "image/png" }]);
    expect(result.request.parameters.seed).toBe(12);
  });

  test("fal maps the scene size onto an image_size preset", async () => {
    const adapter = getVisualProviderAdapter("fal")!;
    const result = await adapter.build(asset("fal"), connection("fal", "fal-ai/flux/schnell"));
    expect(result.request.parameters.imageSize).toBe("landscape_4_3");
  });

  test("Ideogram and BFL keep their explicit sizing parameters", async () => {
    const ideogram = await getVisualProviderAdapter("ideogram")!.build(asset("ideogram"), connection("ideogram", "ideogram-4-5"));
    expect(ideogram.request.parameters).toMatchObject({ size: "1216x832", aspectRatio: "3x2" });

    const bfl = await getVisualProviderAdapter("bfl")!.build(asset("bfl"), connection("bfl", "flux-pro-1.1"));
    expect(bfl.request.parameters).toMatchObject({ width: 1216, height: 832, aspectRatio: "3:2", seed: 12 });
  });

  test("Venice native and Runware receive explicit width/height", async () => {
    const venice = await getVisualProviderAdapter("venice")!.build(asset("venice"), connection("venice", "venice-sd35"));
    expect(venice.request.parameters).toMatchObject({ width: 1216, height: 832 });

    const runware = await getVisualProviderAdapter("runware")!.build(asset("runware"), connection("runware", "runware:100@1"));
    expect(runware.request.parameters).toMatchObject({ width: 1216, height: 832 });
  });

  test("source images are redacted from the settings snapshot", async () => {
    const adapter = getVisualProviderAdapter("bfl")!;
    const result = await adapter.build(asset("bfl", { source_image: { data: "QUJD", mimeType: "image/png" } }), connection("bfl", "flux-pro-1.1"));
    expect((result.settingsSnapshot.parameters as Record<string, unknown>).resolvedSourceImages).toBe("[source image]");
  });
});
