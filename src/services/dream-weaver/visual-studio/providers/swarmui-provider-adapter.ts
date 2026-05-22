import type { ImageGenConnectionProfile } from "../../../../types/image-gen-connection";
import type { VisualProviderAdapter } from "../provider-adapter";
import { readComfyUIConfig } from "../comfyui-workflow-storage";
import { comfyUIProviderAdapter } from "./comfyui-provider-adapter";
import { createSimpleProviderAdapter } from "./simple-provider-adapter";

const swarmuiSimpleAdapter = createSimpleProviderAdapter("swarmui");

// When the SwarmUI connection has an imported ComfyUI workflow we delegate to
// the comfy adapter (which patches the workflow + the SwarmUI provider routes
// it through /ComfyBackendDirect). Without a workflow we fall back to the
// simple swarmui parameter-based adapter.
function pickInner(connection: ImageGenConnectionProfile): VisualProviderAdapter {
  return readComfyUIConfig(connection.metadata) ? comfyUIProviderAdapter : swarmuiSimpleAdapter;
}

export const swarmUIProviderAdapter: VisualProviderAdapter = {
  provider: "swarmui",
  supportsWorkflowImport: true,
  supportsAdvancedMode: false,

  async validate(asset, connection, apiKey) {
    return pickInner(connection).validate(asset, connection, apiKey);
  },

  async build(asset, connection, apiKey) {
    return pickInner(connection).build(asset, connection, apiKey);
  },
};
