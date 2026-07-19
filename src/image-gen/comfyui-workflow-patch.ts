export type ComfyUIMappedFieldSemantic =
  | "positive_prompt"
  | "negative_prompt"
  | "seed"
  | "steps"
  | "cfg"
  | "sampler_name"
  | "scheduler"
  | "width"
  | "height"
  | "checkpoint"
  | "unet"
  | "lora_name"
  | "lora_strength_model"
  | "lora_strength_clip"
  // img2img: the LoadImage filename (uploaded to ComfyUI at generation time) and
  // the KSampler denoise strength (lower = closer to the source image).
  | "init_image"
  | "denoise"
  | "custom";

export interface ComfyUIFieldMapping {
  nodeId: string;
  fieldName: string;
  mappedAs: ComfyUIMappedFieldSemantic;
  autoDetected?: boolean;
}

export interface LoraEntry {
  lora_name: string;
  weight_model: number;
  weight_clip?: number;
}

export interface ComfyUIPatchValues {
  positive_prompt?: string;
  negative_prompt?: string;
  seed?: number;
  steps?: number;
  cfg?: number;
  sampler_name?: string;
  scheduler?: string;
  width?: number;
  height?: number;
  checkpoint?: string;
  unet?: string;
  lora_name?: string;
  lora_strength_model?: number;
  lora_strength_clip?: number;
  loras?: LoraEntry[];
  /** Uploaded LoadImage filename (resolved server-side via /upload/image). */
  init_image?: string;
  /** KSampler denoise for img2img (0–1, lower = closer to the source image). */
  denoise?: number;
  custom?: Record<string, unknown>;
}

type ApiWorkflow = Record<string, { class_type: string; inputs: Record<string, any> }>;

export function patchWorkflow(
  workflow: ApiWorkflow,
  mappings: ComfyUIFieldMapping[],
  values: ComfyUIPatchValues,
): ApiWorkflow {
  const patched: ApiWorkflow = JSON.parse(JSON.stringify(workflow));
  const validNodeIds = new Set(Object.keys(patched));
  const loraEntriesByNodeId = buildLoraEntryMap(mappings, values.loras, validNodeIds);

  for (const mapping of mappings) {
    const node = patched[mapping.nodeId];
    if (!node || typeof node.inputs !== "object") continue;

    const value = resolveMappedValue(mapping, values, loraEntriesByNodeId);
    if (value === undefined) continue;

    node.inputs[mapping.fieldName] = value;
  }

  return patched;
}

function buildLoraEntryMap(
  mappings: ComfyUIFieldMapping[],
  loras: LoraEntry[] | undefined,
  validNodeIds: Set<string>,
): Map<string, LoraEntry> | undefined {
  if (!loras?.length) return undefined;

  const entriesByNodeId = new Map<string, LoraEntry>();
  for (const mapping of mappings) {
    if (!isLoraMapping(mapping) || entriesByNodeId.has(mapping.nodeId)) continue;
    if (!validNodeIds.has(mapping.nodeId)) continue;
    if (entriesByNodeId.size >= loras.length) break;

    const lora = loras[entriesByNodeId.size];
    if (lora === undefined) break;
    entriesByNodeId.set(mapping.nodeId, lora);
  }

  return entriesByNodeId;
}

function isLoraMapping(mapping: ComfyUIFieldMapping): boolean {
  return (
    mapping.mappedAs === "lora_name" ||
    mapping.mappedAs === "lora_strength_model" ||
    mapping.mappedAs === "lora_strength_clip"
  );
}

function resolveMappedValue(
  mapping: ComfyUIFieldMapping,
  values: ComfyUIPatchValues,
  loraEntriesByNodeId: Map<string, LoraEntry> | undefined,
): unknown {
  switch (mapping.mappedAs) {
    case "positive_prompt":
      return values.positive_prompt;
    case "negative_prompt":
      return values.negative_prompt;
    case "seed":
      return values.seed;
    case "steps":
      return values.steps;
    case "cfg":
      return values.cfg;
    case "sampler_name":
      return values.sampler_name;
    case "scheduler":
      return values.scheduler;
    case "width":
      return values.width;
    case "height":
      return values.height;
    case "checkpoint":
      return values.checkpoint;
    case "unet":
      return values.unet;
    case "lora_name": {
      const lora = loraEntriesByNodeId?.get(mapping.nodeId);
      return loraEntriesByNodeId ? lora?.lora_name : values.lora_name;
    }
    case "lora_strength_model": {
      const lora = loraEntriesByNodeId?.get(mapping.nodeId);
      return loraEntriesByNodeId ? lora?.weight_model : values.lora_strength_model;
    }
    case "lora_strength_clip": {
      const lora = loraEntriesByNodeId?.get(mapping.nodeId);
      if (!loraEntriesByNodeId) return values.lora_strength_clip;

      return lora ? lora.weight_clip ?? lora.weight_model : undefined;
    }
    case "init_image":
      return values.init_image;
    case "denoise":
      return values.denoise;
    case "custom":
      return values.custom?.[`${mapping.nodeId}:${mapping.fieldName}`];
    default:
      return undefined;
  }
}
