import { getImageProvider } from "../../../../image-gen/registry";
import "../../../../image-gen/index";
import type {
  WeaverVisualProvider,
  WeaverVisualAsset,
  WeaverVisualImageInputMechanism,
  WeaverVisualSourceImage,
} from "../../../../types/weaver";
import type { VisualProviderAdapter } from "../provider-adapter";

type SimpleVisualProvider = Extract<
  WeaverVisualProvider,
  "novelai" | "nanogpt" | "google_gemini" | "sdapi" | "swarmui"
>;

const IMAGE_INPUT: Record<SimpleVisualProvider, WeaverVisualImageInputMechanism> = {
  google_gemini: "edit",
  nanogpt: "edit",
  novelai: "reference",
  sdapi: "init",
  swarmui: "init",
};

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
      parameters.resolvedSourceImages = [{ data: source.data, mimeType: source.mimeType }];
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
  switch (provider) {
    case "novelai":
      return {
        resolution: `${asset.width}x${asset.height}`,
        ...(asset.seed != null ? { seed: asset.seed } : {}),
      };
    case "nanogpt":
      return {
        size: `${asset.width}x${asset.height}`,
        ...(asset.seed != null ? { seed: asset.seed } : {}),
      };
    case "google_gemini":
      return {
        aspectRatio: asset.aspect_ratio,
      };
    case "sdapi":
    case "swarmui": {
      const stateParams = (asset.provider_state?.params ?? {}) as Record<string, unknown>;
      const stateWidth = stateParams.width != null ? Number(stateParams.width) : NaN;
      const stateHeight = stateParams.height != null ? Number(stateParams.height) : NaN;
      return {
        width: Number.isFinite(stateWidth) && stateWidth > 0 ? stateWidth : asset.width,
        height: Number.isFinite(stateHeight) && stateHeight > 0 ? stateHeight : asset.height,
        ...(asset.seed != null ? { seed: asset.seed } : {}),
      };
    }
  }
}

export function createSimpleProviderAdapter(
  provider: SimpleVisualProvider,
): VisualProviderAdapter {
  return {
    provider,
    supportsWorkflowImport: false,
    supportsAdvancedMode: false,
    imageInput: IMAGE_INPUT[provider],
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
      return errors;
    },
    async build(asset, connection) {
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
