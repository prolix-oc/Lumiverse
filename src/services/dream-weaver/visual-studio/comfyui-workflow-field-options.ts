import type { ComfyUIObjectInfo } from "../../../image-gen/comfyui-discovery";

export type ComfyUIWorkflowFieldOptions = Record<string, string[]>;

function extractFieldOptions(fieldSchema: unknown): string[] {
  if (!Array.isArray(fieldSchema)) return [];

  if (Array.isArray(fieldSchema[0])) {
    return fieldSchema[0].filter((value): value is string => typeof value === "string");
  }

  if (
    fieldSchema[0] === "COMBO" &&
    fieldSchema[1] &&
    typeof fieldSchema[1] === "object" &&
    Array.isArray((fieldSchema[1] as any).options)
  ) {
    return (fieldSchema[1] as any).options.filter((value: unknown): value is string => typeof value === "string");
  }

  return [];
}

function isLinkedWorkflowInput(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string";
}

export function buildComfyUIWorkflowFieldOptions(
  workflow: Record<string, any>,
  objectInfo: ComfyUIObjectInfo | null | undefined,
): ComfyUIWorkflowFieldOptions {
  if (!objectInfo) return {};

  const fieldOptions: ComfyUIWorkflowFieldOptions = {};

  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node || typeof node !== "object") continue;
    const classType = (node as any).class_type;
    if (typeof classType !== "string" || !classType.trim()) continue;

    const nodeInfo = objectInfo[classType];
    if (!nodeInfo) continue;

    const inputs = typeof (node as any).inputs === "object" && (node as any).inputs
      ? (node as any).inputs as Record<string, unknown>
      : {};
    const declaredFields = {
      ...(nodeInfo.input?.required ?? {}),
      ...(nodeInfo.input?.optional ?? {}),
    };

    for (const [fieldName, schema] of Object.entries(declaredFields)) {
      if (isLinkedWorkflowInput(inputs[fieldName])) continue;

      const options = extractFieldOptions(schema);
      if (options.length === 0) continue;

      fieldOptions[`${nodeId}:${fieldName}`] = options;
    }
  }

  return fieldOptions;
}
