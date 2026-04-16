import type { DreamWeaverVisualAsset } from "../../../../types/dream-weaver";
import type { ImageGenConnectionProfile } from "../../../../types/image-gen-connection";
import { normalizeComfyUIWorkflow } from "../../../../image-gen/comfyui-import";
import { getComfyUIObjectInfo } from "../../../../image-gen/comfyui-discovery";
import type { VisualProviderAdapter } from "../provider-adapter";
import { readComfyUIConfig } from "../comfyui-workflow-storage";
import { patchWorkflow, type ComfyUIPatchValues } from "../comfyui-workflow-patch";

/**
 * Build the ComfyUI generation request by patching values into the user's stored workflow.
 *
 * The stored workflow lives in `connection.metadata.comfyui` and was uploaded by the user
 * earlier. This adapter never constructs workflows from scratch - it only substitutes
 * values at the node positions the user explicitly mapped.
 */
export const comfyUIProviderAdapter: VisualProviderAdapter = {
  provider: "comfyui",
  supportsWorkflowImport: true,
  supportsAdvancedMode: false,

  async validate(asset: DreamWeaverVisualAsset, connection: ImageGenConnectionProfile) {
    const errors: string[] = [];

    if (connection.provider !== "comfyui") {
      errors.push("Connection provider must be comfyui.");
      return errors;
    }

    const config = readComfyUIConfig(connection.metadata);
    if (!config) {
      errors.push("No ComfyUI workflow has been imported for this connection. Import a workflow first.");
      return errors;
    }

    const hasPositivePrompt = config.field_mappings.some(
      (m) => m.mappedAs === "positive_prompt",
    );
    if (!hasPositivePrompt) {
      errors.push("At least one node field must be mapped as the positive prompt.");
    }

    if (!asset.prompt.trim()) {
      errors.push("Visual asset prompt is required.");
    }

    return errors;
  },

  async build(asset: DreamWeaverVisualAsset, connection: ImageGenConnectionProfile) {
    const config = readComfyUIConfig(connection.metadata);
    if (!config) {
      throw new Error("ComfyUI connection has no imported workflow.");
    }

    const values: ComfyUIPatchValues = {
      positive_prompt: asset.prompt,
      negative_prompt: asset.negative_prompt || undefined,
      seed: asset.seed ?? undefined,
      width: asset.width,
      height: asset.height,
    };

    // Merge any additional field values the asset's provider_state may supply (steps,
    // cfg, sampler overrides the user set in the mapped-fields form). These come through as
    // a flat record keyed by semantic label.
    const assetExtras = asset.provider_state?.comfyui_field_values;
    if (assetExtras && typeof assetExtras === "object") {
      Object.assign(values, assetExtras);
    }

    const objectInfo = await getComfyUIObjectInfo(connection.api_url || "http://localhost:8188");
    const normalizedWorkflow = normalizeComfyUIWorkflow(
      config.workflow_json,
      objectInfo ?? undefined,
    );
    const patchableWorkflow = normalizedWorkflow.apiWorkflow;

    const patchedWorkflow = patchWorkflow(
      patchableWorkflow,
      config.field_mappings,
      values,
    );

    return {
      request: {
        prompt: asset.prompt,
        negativePrompt: asset.negative_prompt || undefined,
        model: connection.model,
        parameters: {
          workflow: patchedWorkflow,
          workflowFormat: "api_prompt",
          preserveImportedWorkflow: true,
        },
      },
      settingsSnapshot: {
        provider: "comfyui",
        model: connection.model,
        workflow_format: normalizedWorkflow.format,
        mapped_fields: config.field_mappings.map((m) => ({
          nodeId: m.nodeId,
          fieldName: m.fieldName,
          mappedAs: m.mappedAs,
        })),
      },
    };
  },
};
