import type {
  DreamWeaverVisualAsset,
  DreamWeaverVisualProvider,
} from "../../../types/dream-weaver";
import type { ImageGenConnectionProfile } from "../../../types/image-gen-connection";
import type { ImageGenRequest } from "../../../image-gen/types";

export interface VisualAdapterBuildResult {
  request: ImageGenRequest;
  settingsSnapshot: Record<string, unknown>;
}

export interface VisualProviderAdapter {
  provider: DreamWeaverVisualProvider;
  supportsWorkflowImport: boolean;
  supportsAdvancedMode: boolean;
  validate(
    asset: DreamWeaverVisualAsset,
    connection: ImageGenConnectionProfile,
  ): Promise<string[]>;
  build(
    asset: DreamWeaverVisualAsset,
    connection: ImageGenConnectionProfile,
  ): Promise<VisualAdapterBuildResult>;
}
