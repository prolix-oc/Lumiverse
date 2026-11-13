import type { WeaverVisualAsset } from "../../../../types/weaver";
import type { ImageGenConnectionProfile } from "../../../../types/image-gen-connection";
import { normalizeComfyUIWorkflow } from "../../../../image-gen/comfyui-import";
import { getComfyUIObjectInfo, resolveComfyTarget } from "../../../../image-gen/comfyui-discovery";
import { uploadComfyImage } from "../../../../image-gen/providers/comfy-runner";
import type { VisualProviderAdapter, VisualImageInputSupport } from "../provider-adapter";
import { readComfyUIConfig } from "../comfyui-workflow-storage";
import { patchWorkflow, type ComfyUIPatchValues } from "../comfyui-workflow-patch";

const INIT_DENOISE_DEFAULT = 0.5;

export function comfyImageInputSupport(
  connection: ImageGenConnectionProfile,
): VisualImageInputSupport {
  const config = readComfyUIConfig(connection.metadata);
  if (!config) {
    return {
      supported: false,
      mechanism: null,
      reason: "No ComfyUI workflow has been imported for this connection.",
    };
  }
  const hasInitImage = config.field_mappings.some((m) => m.mappedAs === "init_image");
  if (!hasInitImage) {
    return {
      supported: false,
      mechanism: null,
      reason: "The imported workflow has no init_image mapping, so it cannot take a source image.",
    };
  }
  return { supported: true, mechanism: "init" };
}

export const comfyUIProviderAdapter: VisualProviderAdapter = {
  provider: "comfyui",
  supportsWorkflowImport: true,
  supportsAdvancedMode: false,
  imageInput: "init",
  checkImageInput: comfyImageInputSupport,

  async validate(asset: WeaverVisualAsset, connection: ImageGenConnectionProfile) {
    const errors: string[] = [];

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

    if (asset.source_image) {
      const support = comfyImageInputSupport(connection);
      if (!support.supported && support.reason) {
        errors.push(support.reason);
      }
    }

    if (!asset.prompt.trim()) {
      errors.push("Visual asset prompt is required.");
    }

    return errors;
  },

  async build(asset: WeaverVisualAsset, connection: ImageGenConnectionProfile, apiKey?: string) {
    const config = readComfyUIConfig(connection.metadata);
    if (!config) {
      throw new Error("Connection has no imported workflow.");
    }

    const values: ComfyUIPatchValues = {
      positive_prompt: asset.prompt,
      negative_prompt: asset.negative_prompt || undefined,
      seed: asset.seed ?? undefined,
      width: asset.width,
      height: asset.height,
    };

    const assetExtras = asset.provider_state?.comfyui_field_values;
    if (assetExtras && typeof assetExtras === "object") {
      Object.assign(values, assetExtras);
    }

    const target = resolveComfyTarget(connection, apiKey);
    const objectInfo = await getComfyUIObjectInfo(target.baseUrl, false, { cookie: target.cookie });
    const normalizedWorkflow = normalizeComfyUIWorkflow(
      config.workflow_json,
      objectInfo ?? undefined,
    );
    const patchableWorkflow = normalizedWorkflow.apiWorkflow;

    if (asset.source_image) {
      const uploaded = await uploadComfyImage(
        target.baseUrl,
        { data: asset.source_image.data, mimeType: asset.source_image.mimeType },
        { cookie: target.cookie },
      );
      values.init_image = uploaded.subfolder
        ? `${uploaded.subfolder}/${uploaded.name}`
        : uploaded.name;
      if (values.denoise === undefined) {
        const stateDenoise = Number((asset.provider_state?.params as Record<string, unknown> | undefined)?.denoise);
        values.denoise = Number.isFinite(stateDenoise) ? stateDenoise : INIT_DENOISE_DEFAULT;
      }
    }

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
        provider: connection.provider,
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
