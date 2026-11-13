import type {
  WeaverVisualAsset,
  WeaverVisualImageInputMechanism,
  WeaverVisualProvider,
} from "../../../types/weaver";
import type { ImageGenConnectionProfile } from "../../../types/image-gen-connection";
import type { ImageGenRequest } from "../../../image-gen/types";

export interface VisualAdapterBuildResult {
  request: ImageGenRequest;
  settingsSnapshot: Record<string, unknown>;
}

export interface VisualImageInputSupport {
  supported: boolean;
  mechanism: WeaverVisualImageInputMechanism | null;
  reason?: string;
}

export interface VisualProviderAdapter {
  provider: WeaverVisualProvider;
  supportsWorkflowImport: boolean;
  supportsAdvancedMode: boolean;
  imageInput: WeaverVisualImageInputMechanism | null;
  checkImageInput?(connection: ImageGenConnectionProfile): VisualImageInputSupport;
  validate(
    asset: WeaverVisualAsset,
    connection: ImageGenConnectionProfile,
    apiKey?: string,
  ): Promise<string[]>;
  build(
    asset: WeaverVisualAsset,
    connection: ImageGenConnectionProfile,
    apiKey?: string,
  ): Promise<VisualAdapterBuildResult>;
}

export function adapterImageInput(
  adapter: VisualProviderAdapter,
  connection: ImageGenConnectionProfile,
): VisualImageInputSupport {
  if (adapter.checkImageInput) return adapter.checkImageInput(connection);
  if (adapter.imageInput) return { supported: true, mechanism: adapter.imageInput };
  return {
    supported: false,
    mechanism: null,
    reason: "This image provider cannot take an image as input.",
  };
}
