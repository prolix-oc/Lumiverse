import type { ComfyUIFieldMapping } from "./comfyui-workflow-patch";
import type { ComfyUIWorkflowFormat } from "./comfyui-import";
import { detectComfyUIWorkflowFormat } from "./comfyui-import";

export interface ComfyUIWorkflowConfig {
  workflow_json: Record<string, any>;
  workflow_api_json: Record<string, any>;
  workflow_format: ComfyUIWorkflowFormat;
  field_mappings: ComfyUIFieldMapping[];
  field_options?: Record<string, string[]>;
  imported_at: number;
  needs_reimport?: boolean;
}

export interface ComfyUIWorkflowLibraryEntry {
  id: string;
  name: string;
  updated_at: number;
  config: ComfyUIWorkflowConfig;
}

export interface ComfyUIWorkflowLibrary {
  entries: ComfyUIWorkflowLibraryEntry[];
  activeId: string | null;
}

function parseComfyUIConfigValue(value: unknown): ComfyUIWorkflowConfig | null {
  if (!value || typeof value !== "object") return null;

  const config = value as Record<string, unknown>;
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

export function readComfyUIConfig(metadata: unknown): ComfyUIWorkflowConfig | null {
  if (!metadata || typeof metadata !== "object") return null;
  return parseComfyUIConfigValue((metadata as Record<string, unknown>).comfyui);
}

export function writeComfyUIConfig(
  metadata: unknown,
  config: ComfyUIWorkflowConfig,
): Record<string, unknown> {
  const base = metadata && typeof metadata === "object" ? { ...(metadata as Record<string, unknown>) } : {};
  base.comfyui = config;
  return base;
}

export function clearComfyUIConfig(metadata: unknown): Record<string, unknown> {
  const base = metadata && typeof metadata === "object" ? { ...(metadata as Record<string, unknown>) } : {};
  delete base.comfyui;
  return base;
}

export function readComfyUIWorkflowLibrary(metadata: unknown): ComfyUIWorkflowLibrary {
  if (!metadata || typeof metadata !== "object") return { entries: [], activeId: null };
  const record = metadata as Record<string, unknown>;

  const entries: ComfyUIWorkflowLibraryEntry[] = [];
  if (Array.isArray(record.comfyui_workflows)) {
    for (const raw of record.comfyui_workflows) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      if (typeof entry.id !== "string" || typeof entry.name !== "string") continue;
      const config = parseComfyUIConfigValue(entry.config);
      if (!config) continue;
      entries.push({
        id: entry.id,
        name: entry.name,
        updated_at: typeof entry.updated_at === "number" ? entry.updated_at : 0,
        config,
      });
    }
  }

  const rawActiveId = record.comfyui_active_workflow_id;
  const activeId =
    typeof rawActiveId === "string" && entries.some((e) => e.id === rawActiveId)
      ? rawActiveId
      : null;

  return { entries, activeId };
}

export function writeComfyUIWorkflowLibrary(
  metadata: unknown,
  library: ComfyUIWorkflowLibrary,
): Record<string, unknown> {
  const base = metadata && typeof metadata === "object" ? { ...(metadata as Record<string, unknown>) } : {};
  base.comfyui_workflows = library.entries;
  if (library.activeId) {
    base.comfyui_active_workflow_id = library.activeId;
  } else {
    delete base.comfyui_active_workflow_id;
  }
  return base;
}

export function syncActiveComfyUIWorkflowToLibrary(
  metadata: unknown,
  config: ComfyUIWorkflowConfig,
  updatedAt: number,
): Record<string, unknown> {
  const base = writeComfyUIConfig(metadata, config);
  const library = readComfyUIWorkflowLibrary(base);
  if (!library.activeId) return base;
  const entries = library.entries.map((entry) =>
    entry.id === library.activeId ? { ...entry, config, updated_at: updatedAt } : entry,
  );
  return writeComfyUIWorkflowLibrary(base, { entries, activeId: library.activeId });
}
