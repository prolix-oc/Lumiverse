export interface DetectedInjectionPoint {
  nodeId: string;
  classType: string;
  fieldName: string;
  currentValue: unknown;
  /** Semantic label if we can infer it, otherwise just the field name */
  suggestedAs:
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
    | null;
}

type ApiWorkflow = Record<string, { class_type: string; inputs: Record<string, any> }>;

const KNOWN_FIELD_HINTS: Record<string, Record<string, DetectedInjectionPoint["suggestedAs"]>> = {
  CLIPTextEncode: {
    text: "positive_prompt",
  },
  CLIPTextEncodeSDXL: {
    text_g: "positive_prompt",
    text_l: "positive_prompt",
  },
  KSampler: {
    seed: "seed",
    steps: "steps",
    cfg: "cfg",
    sampler_name: "sampler_name",
    scheduler: "scheduler",
  },
  KSamplerAdvanced: {
    noise_seed: "seed",
    steps: "steps",
    cfg: "cfg",
    sampler_name: "sampler_name",
    scheduler: "scheduler",
  },
  EmptyLatentImage: {
    width: "width",
    height: "height",
  },
  EmptySD3LatentImage: {
    width: "width",
    height: "height",
  },
  CheckpointLoaderSimple: {
    ckpt_name: "checkpoint",
  },
};

/**
 * Walk an API-format workflow and return every field that matches our known injection hints.
 * Results are suggestions - the user confirms or edits mappings via the UI.
 *
 * For negative prompt detection, we use a heuristic: the second CLIPTextEncode text field
 * (by node ID order) is assumed to be negative unless there's topological evidence otherwise.
 * Users can correct this in the UI.
 */
export function detectInjectionPoints(workflow: ApiWorkflow): DetectedInjectionPoint[] {
  const points: DetectedInjectionPoint[] = [];
  const clipTextNodeOrder: string[] = [];

  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node || typeof node !== "object") continue;
    const classType = node.class_type;
    const hints = KNOWN_FIELD_HINTS[classType];
    if (!hints) continue;

    if (classType === "CLIPTextEncode" || classType === "CLIPTextEncodeSDXL") {
      clipTextNodeOrder.push(nodeId);
    }

    for (const [fieldName, suggestedAs] of Object.entries(hints)) {
      if (!(fieldName in node.inputs)) continue;
      points.push({
        nodeId,
        classType,
        fieldName,
        currentValue: node.inputs[fieldName],
        suggestedAs,
      });
    }
  }

  // Heuristic: if there are exactly two CLIPTextEncode nodes, mark the second as negative.
  if (clipTextNodeOrder.length === 2) {
    const secondNodeId = clipTextNodeOrder[1];
    for (const point of points) {
      if (point.nodeId === secondNodeId && point.suggestedAs === "positive_prompt") {
        point.suggestedAs = "negative_prompt";
      }
    }
  }

  return points;
}

/**
 * Return the list of all possible injectable fields for a given node, based on its inputs.
 * Used by the node context menu to show every field the user could mark, not just the
 * auto-detected ones.
 */
export function listNodeInjectableFields(
  workflow: ApiWorkflow,
  nodeId: string,
): Array<{ fieldName: string; currentValue: unknown }> {
  const node = workflow[nodeId];
  if (!node || typeof node.inputs !== "object") return [];
  const fields: Array<{ fieldName: string; currentValue: unknown }> = [];
  for (const [fieldName, value] of Object.entries(node.inputs)) {
    // Skip link references
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string") {
      continue;
    }
    fields.push({ fieldName, currentValue: value });
  }
  return fields;
}
