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
  // apiKey is forwarded so adapters that talk to auth-gated backends
  // (e.g. SwarmUI's /ComfyBackendDirect for object_info discovery) can sign
  // the request. Adapters that don't need auth simply ignore it.
  validate(
    asset: DreamWeaverVisualAsset,
    connection: ImageGenConnectionProfile,
    apiKey?: string,
  ): Promise<string[]>;
  build(
    asset: DreamWeaverVisualAsset,
    connection: ImageGenConnectionProfile,
    apiKey?: string,
  ): Promise<VisualAdapterBuildResult>;
}
