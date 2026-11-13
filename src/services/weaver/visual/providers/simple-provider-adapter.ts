import { getImageProvider } from "../../../../image-gen/registry";
import "../../../../image-gen/index";
import type {
  WeaverVisualProvider,
  WeaverVisualAsset,
  WeaverVisualSourceImage,
} from "../../../../types/weaver";
import type { VisualProviderAdapter } from "../provider-adapter";
import { imageInputMechanism } from "../../../../image-gen/image-input";

type SimpleVisualProvider = Exclude<
  WeaverVisualProvider,
  "comfyui"
>;

const NAI_REFERENCE_STRENGTH = 0.6;
const INIT_DENOISE_DEFAULT = 0.5;
const IMAGE_PAYLOAD_KEYS = new Set([
  "resolvedSourceImages",
  "referenceImages",
  "resolvedReferenceImages",
  "init_images",
]);

export function snapshotParameters(parameters: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    Object.entries(parameters).map(([key, value]) =>
      IMAGE_PAYLOAD_KEYS.has(key) ? [key, "[source image]"] : [key, value],
    ),
  );
}

function applySourceImage(
  provider: SimpleVisualProvider,
  source: WeaverVisualSourceImage,
  parameters: Record<string, any>,
): void {
  switch (provider) {
    case "google_gemini":
    case "openrouter":
    case "openai":
    case "xai":
    case "ideogram":
    case "bfl":
    case "fal":
    case "together":
      parameters.resolvedSourceImages = [{ data: source.data, mimeType: source.mimeType }];
      return;
    case "stability":
      parameters.resolvedSourceImages = [{ data: source.data, mimeType: source.mimeType }];
      if (parameters.strength == null) parameters.strength = INIT_DENOISE_DEFAULT;
      return;
    case "runware":
      parameters.resolvedSourceImages = [{ data: source.data, mimeType: source.mimeType }];
      if (parameters.strength == null) parameters.strength = INIT_DENOISE_DEFAULT;
      return;
    case "nanogpt":
      parameters.referenceImages = [{ data: source.data, mimeType: source.mimeType }];
      if (parameters.strength == null) parameters.strength = INIT_DENOISE_DEFAULT;
      return;
    case "novelai":
      parameters.resolvedReferenceImages = [
        {
          data: source.data,
          strength: parameters.referenceStrength ?? NAI_REFERENCE_STRENGTH,
          infoExtracted: 1,
          refType: "character&style",
        },
      ];
      return;
    case "sdapi":
      parameters.mode = "img2img";
      parameters.init_images = `data:${source.mimeType};base64,${source.data}`;
      if (parameters.denoising_strength == null) parameters.denoising_strength = INIT_DENOISE_DEFAULT;
      return;
    case "swarmui":
      parameters.resolvedSourceImages = [{ data: source.data, mimeType: source.mimeType }];
      return;
    default:
      return;
  }
}

function filterSupportedParameters(
  provider: SimpleVisualProvider,
  parameters: Record<string, any> | null | undefined,
): Record<string, any> {
  const schema = getImageProvider(provider)?.capabilities.parameters ?? {};
  return Object.fromEntries(
    Object.entries(parameters ?? {}).filter(([key]) => key in schema),
  );
}

function buildProviderSpecificParameters(
  provider: SimpleVisualProvider,
  asset: WeaverVisualAsset,
): Record<string, any> {
  const sizeParams = (asset.provider_state?.params ?? {}) as Record<string, unknown>;
  const width = sizeParams.width != null ? Number(sizeParams.width) : NaN;
  const height = sizeParams.height != null ? Number(sizeParams.height) : NaN;
  const stateWidth = Number.isFinite(width) && width > 0 ? width : asset.width;
  const stateHeight = Number.isFinite(height) && height > 0 ? height : asset.height;
  const seed = asset.seed != null ? { seed: asset.seed } : {};

  switch (provider) {
    case "novelai":
      return {
        resolution: `${asset.width}x${asset.height}`,
        ...seed,
      };
    case "nanogpt":
      return {
        size: `${asset.width}x${asset.height}`,
        ...seed,
      };
    case "google_gemini":
    case "openrouter":
    case "fireworks":
    case "stability":
    case "civitai_chat":
      return {
        aspectRatio: asset.aspect_ratio,
        ...seed,
      };
    // Ideogram 4.5 takes `size` and 3.0/2.x take `aspect_ratio`; send both so
    // the provider picks per model. 4.0's `resolution` is a fixed enum, so it is
    // left to the connection default rather than derived from the scene size.
    case "ideogram":
      return {
        size: `${stateWidth}x${stateHeight}`,
        aspectRatio: asset.aspect_ratio.replace(":", "x"),
        ...seed,
      };
    case "together":
    case "deepinfra":
    case "venice_compat":
    case "recraft":
    case "custom_openai":
      return {
        size: `${stateWidth}x${stateHeight}`,
        ...seed,
      };
    // xAI sizes with aspect_ratio (not `size`); other reference-image providers
    // that take an aspect ratio are grouped above.
    case "xai":
      return {
        aspectRatio: asset.aspect_ratio,
        ...seed,
      };
    case "venice":
    case "leonardo":
    case "runware":
    case "civitai":
      return {
        width: stateWidth,
        height: stateHeight,
        ...seed,
      };
    case "bfl":
      // Kontext and Ultra consume aspectRatio instead of width/height.
      return { width: stateWidth, height: stateHeight, aspectRatio: asset.aspect_ratio, ...seed };
    case "fal":
      return {
        imageSize: falSizePreset(stateWidth, stateHeight),
        ...seed,
      };
    case "replicate":
      return {
        aspectRatio: asset.aspect_ratio,
        ...seed,
      };
    case "huggingface":
      return { ...seed };
    case "pollinations":
    case "sdapi":
    case "swarmui": {
      return {
        width: stateWidth,
        height: stateHeight,
        ...seed,
      };
    }
    default:
      return {};
  }
}

function falSizePreset(width: number, height: number): string {
  const ratio = width / height;
  const presets: Array<[string, number]> = [
    ["square_hd", 1], ["landscape_4_3", 4 / 3], ["landscape_16_9", 16 / 9],
    ["portrait_4_3", 3 / 4], ["portrait_16_9", 9 / 16],
  ];
  return presets.reduce((best, next) =>
    Math.abs(Math.log(ratio / next[1])) < Math.abs(Math.log(ratio / best[1])) ? next : best,
  )[0];
}

export function createSimpleProviderAdapter(
  provider: SimpleVisualProvider,
): VisualProviderAdapter {
  return {
    provider,
    supportsWorkflowImport: false,
    supportsAdvancedMode: false,
    imageInput: imageInputMechanism(provider),
    checkImageInput(connection) {
      if (provider === "novelai" && connection.model.startsWith("nai-diffusion-5")) {
        return {
          supported: false,
          mechanism: null,
          reason: "NovelAI V5 does not currently support Vibe Transfer or Precise Reference.",
        };
      }
      // Stability's Core endpoint has no image-to-image mode; Ultra and SD3 do.
      if (provider === "stability" && connection.model === "core") {
        return {
          supported: false,
          mechanism: null,
          reason: "Stable Image Core does not accept a source image. Use the Ultra or SD3 model.",
        };
      }
      if (provider === "ideogram" && !/^ideogram-(3|4)/.test(connection.model)) {
        return { supported: false, mechanism: null, reason: "This Ideogram model does not accept a source image. Use Ideogram 3 or 4." };
      }
      if (!imageInputMechanism(provider, connection.model)) {
        return { supported: false, mechanism: null, reason: "This image provider or model cannot take an image as input." };
      }
      return { supported: true, mechanism: imageInputMechanism(provider, connection.model) };
    },
    async validate(asset, connection) {
      const errors: string[] = [];
      if (connection.provider !== provider) {
        errors.push(`Connection provider must be ${provider}.`);
      }
      if (!asset.prompt.trim()) {
        errors.push("Visual asset prompt is required.");
      }
      if (!connection.model?.trim()) {
        errors.push("Connection model is required.");
      }
      const support = this.checkImageInput!(connection);
      if (asset.source_image && !support.supported) {
        errors.push(support.reason!);
      }
      return errors;
    },
    async build(asset, connection) {
      const support = this.checkImageInput!(connection);
      if (asset.source_image && !support.supported) throw new Error(support.reason);
      const supportedDefaults = filterSupportedParameters(
        provider,
        connection.default_parameters,
      );
      const assetParams = filterSupportedParameters(
        provider,
        asset.provider_state?.params as Record<string, any> | undefined,
      );
      const providerParameters = buildProviderSpecificParameters(provider, asset);
      const parameters = {
        ...supportedDefaults,
        ...assetParams,
        ...providerParameters,
      };

      if (asset.source_image) {
        applySourceImage(provider, asset.source_image, parameters);
      }

      return {
        request: {
          prompt: asset.prompt,
          negativePrompt: asset.negative_prompt || undefined,
          model: connection.model,
          parameters,
        },
        settingsSnapshot: {
          provider,
          model: connection.model,
          parameters: snapshotParameters(parameters),
        },
      };
    },
  };
}
