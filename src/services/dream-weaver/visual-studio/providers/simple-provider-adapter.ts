import { getImageProvider } from "../../../../image-gen/registry";
import "../../../../image-gen/index";
import type {
  DreamWeaverVisualProvider,
  DreamWeaverVisualAsset,
} from "../../../../types/dream-weaver";
import type { ImageGenConnectionProfile } from "../../../../types/image-gen-connection";
import type { VisualProviderAdapter } from "../provider-adapter";

type SimpleVisualProvider = Extract<
  DreamWeaverVisualProvider,
  "novelai" | "nanogpt" | "google_gemini"
>;

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
  asset: DreamWeaverVisualAsset,
): Record<string, any> {
  const providerState = asset.provider_state[provider] ?? {};
  const stepOverride =
    typeof providerState.steps === "number" && Number.isFinite(providerState.steps)
      ? providerState.steps
      : undefined;

  switch (provider) {
    case "novelai":
      return {
        resolution: `${asset.width}x${asset.height}`,
        seed: asset.seed ?? undefined,
        steps: stepOverride,
      };
    case "nanogpt":
      return {
        size: `${asset.width}x${asset.height}`,
        seed: asset.seed ?? undefined,
        steps: stepOverride,
      };
    case "google_gemini":
      return {
        aspectRatio: asset.aspect_ratio,
        steps: stepOverride,
      };
  }
}

export function createSimpleProviderAdapter(
  provider: SimpleVisualProvider,
): VisualProviderAdapter {
  return {
    provider,
    supportsWorkflowImport: false,
    supportsAdvancedMode: false,
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
      const providerParameters = buildProviderSpecificParameters(provider, asset);
      const parameters = {
        ...supportedDefaults,
        ...providerParameters,
      };

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
          parameters,
        },
      };
    },
  };
}
