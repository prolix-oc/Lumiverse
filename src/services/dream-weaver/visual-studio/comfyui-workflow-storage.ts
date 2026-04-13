import type { ComfyUIFieldMapping } from "./comfyui-workflow-patch";
import type { ComfyUIWorkflowFormat } from "../../../image-gen/comfyui-import";
import { detectComfyUIWorkflowFormat } from "../../../image-gen/comfyui-import";

export interface ComfyUIWorkflowConfig {
  workflow_json: Record<string, any>;
  workflow_api_json: Record<string, any>;
  workflow_format: ComfyUIWorkflowFormat;
  field_mappings: ComfyUIFieldMapping[];
  field_options?: Record<string, string[]>;
  imported_at: number;
  needs_reimport?: boolean;
}

/**
 * Extract the `comfyui` entry from a connection's metadata JSON.
 * Returns null if no workflow has been imported for this connection.
 */
export function readComfyUIConfig(metadata: unknown): ComfyUIWorkflowConfig | null {
  if (!metadata || typeof metadata !== "object") return null;
  const record = metadata as Record<string, unknown>;
  const comfy = record.comfyui;
  if (!comfy || typeof comfy !== "object") return null;

  const config = comfy as Record<string, unknown>;
  const workflowJson = config.workflow_json;
  const workflowApiJson = config.workflow_api_json;
  const storedWorkflowFormat = config.workflow_format;
  const fieldMappings = config.field_mappings;
  const fieldOptions =
    config.field_options && typeof config.field_options === "object"
      ? (config.field_options as Record<string, string[]>)
      : undefined;
  const importedAt = config.imported_at;

  if (!workflowJson || typeof workflowJson !== "object") return null;
  const normalizedApiWorkflow =
    workflowApiJson && typeof workflowApiJson === "object"
      ? (workflowApiJson as Record<string, any>)
      : (workflowJson as Record<string, any>);
  if (storedWorkflowFormat !== "ui_workflow" && storedWorkflowFormat !== "api_prompt") return null;
  if (!Array.isArray(fieldMappings)) return null;
  if (typeof importedAt !== "number") return null;

  const graphWorkflowFormat = detectComfyUIWorkflowFormat(workflowJson);
  const needsReimport =
    !workflowApiJson &&
    storedWorkflowFormat === "ui_workflow" &&
    graphWorkflowFormat !== "ui_workflow";

  return {
    workflow_json: workflowJson as Record<string, any>,
    workflow_api_json: normalizedApiWorkflow,
    workflow_format: graphWorkflowFormat,
    field_mappings: fieldMappings as ComfyUIFieldMapping[],
    field_options: fieldOptions,
    imported_at: importedAt,
    needs_reimport: needsReimport,
  };
}

/**
 * Merge a ComfyUI workflow config into an existing metadata blob.
 * Returns a new metadata object - does not mutate the input.
 */
export function writeComfyUIConfig(
  metadata: unknown,
  config: ComfyUIWorkflowConfig,
): Record<string, unknown> {
  const base = metadata && typeof metadata === "object" ? { ...(metadata as Record<string, unknown>) } : {};
  base.comfyui = config;
  return base;
}

/**
 * Remove the `comfyui` entry from a metadata blob.
 * Used when the user wants to clear their imported workflow.
 */
export function clearComfyUIConfig(metadata: unknown): Record<string, unknown> {
  const base = metadata && typeof metadata === "object" ? { ...(metadata as Record<string, unknown>) } : {};
  delete base.comfyui;
  return base;
}
