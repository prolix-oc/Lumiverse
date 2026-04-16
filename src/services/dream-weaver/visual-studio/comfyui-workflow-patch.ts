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
  | "custom";

export interface ComfyUIFieldMapping {
  nodeId: string;
  fieldName: string;
  mappedAs: ComfyUIMappedFieldSemantic;
  autoDetected?: boolean;
}

/**
 * Values to inject into a workflow at generation time.
 */
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
  /** For custom-mapped fields, keyed by `${nodeId}:${fieldName}` */
  custom?: Record<string, unknown>;
}

type ApiWorkflow = Record<string, { class_type: string; inputs: Record<string, any> }>;

export function patchWorkflow(
  workflow: ApiWorkflow,
  mappings: ComfyUIFieldMapping[],
  values: ComfyUIPatchValues,
): ApiWorkflow {
  // Deep-clone the workflow so we never mutate caller state.
  const patched: ApiWorkflow = JSON.parse(JSON.stringify(workflow));

  for (const mapping of mappings) {
    const node = patched[mapping.nodeId];
    if (!node || typeof node.inputs !== "object") continue;

    const value = resolveMappedValue(mapping, values);
    if (value === undefined) continue;

    node.inputs[mapping.fieldName] = value;
  }

  return patched;
}

function resolveMappedValue(
  mapping: ComfyUIFieldMapping,
  values: ComfyUIPatchValues,
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
    case "custom": {
      const key = `${mapping.nodeId}:${mapping.fieldName}`;
      return values.custom?.[key];
    }
    default:
      return undefined;
  }
}
