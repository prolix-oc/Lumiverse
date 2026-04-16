import type { ComfyUIObjectInfo } from "./comfyui-discovery";

export type ComfyUIWorkflowFormat = "ui_workflow" | "api_prompt";

type ComfyUINodeSchema = ComfyUIObjectInfo[string];
type UiWorkflowNode = Record<string, any>;

const UI_ONLY_PASSTHROUGH_TYPES = new Set(["Reroute"]);
const BYPASS_NODE_MODE = 4;

const KNOWN_WIDGET_FIELD_ORDER: Record<string, string[]> = {
  CheckpointLoaderSimple: ["ckpt_name"],
  CLIPTextEncode: ["text"],
  CLIPTextEncodeSDXL: ["text_g", "text_l"],
  EmptyLatentImage: ["width", "height", "batch_size"],
  EmptySD3LatentImage: ["width", "height", "batch_size"],
  KSampler: ["seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"],
  KSamplerAdvanced: [
    "noise_seed",
    "steps",
    "cfg",
    "sampler_name",
    "scheduler",
    "start_at_step",
    "end_at_step",
    "return_with_leftover_noise",
  ],
};

export function detectComfyUIWorkflowFormat(workflow: unknown): ComfyUIWorkflowFormat {
  if (!workflow || typeof workflow !== "object") return "api_prompt";
  const record = workflow as Record<string, unknown>;
  if (Array.isArray(record.nodes) && Array.isArray(record.links)) {
    return "ui_workflow";
  }
  return "api_prompt";
}

export function convertUiWorkflowToApi(
  workflow: Record<string, any>,
  objectInfo?: ComfyUIObjectInfo,
): Record<string, any> {
  if (!Array.isArray(workflow.nodes)) {
    throw new Error("convertUiWorkflowToApi: expected `nodes` array on UI workflow");
  }

  const nodes = workflow.nodes as Array<Record<string, any>>;
  const links = Array.isArray(workflow.links) ? (workflow.links as any[]) : [];
  const nodesById = new Map<string, UiWorkflowNode>(
    nodes.map((node) => [String(node.id), node]),
  );
  const outgoingLinkCounts = new Map<string, number>();

  const linkMap = new Map<number, { from: [string, number] }>();
  for (const link of links) {
    if (!Array.isArray(link) || link.length < 5) continue;
    const [linkId, srcNodeId, srcSlot] = link;
    if (typeof linkId !== "number") continue;
    const sourceNodeId = String(srcNodeId);
    linkMap.set(linkId, {
      from: [sourceNodeId, Number(srcSlot) || 0],
    });
    outgoingLinkCounts.set(sourceNodeId, (outgoingLinkCounts.get(sourceNodeId) ?? 0) + 1);
  }

  const api: Record<string, any> = {};

  for (const node of nodes) {
    const id = String(node.id);
    const classType = getUiNodeClassType(node);
    if (!classType) continue;
    if (shouldSkipUiNodeFromApi(node, classType, id, outgoingLinkCounts, objectInfo)) {
      continue;
    }

    const inputs: Record<string, any> = {};
    const linkedFieldNames = new Set<string>();
    const assignedWidgetFieldNames = new Set<string>();

    if (Array.isArray(node.inputs)) {
      for (const input of node.inputs) {
        if (!input || typeof input !== "object") continue;
        const name = input.name;
        const linkId = input.link;
        if (typeof name !== "string") continue;
        if (typeof linkId === "number") {
          linkedFieldNames.add(name);
        } else {
          continue;
        }
        const resolved = resolveUiLinkSource(
          linkId,
          linkMap,
          nodesById,
          objectInfo,
        );
        if (resolved) {
          inputs[name] = resolved;
        }
      }
    }

    if (Array.isArray(node.widgets_values)) {
      let widgetIndex = applyWidgetValuesFromNodeInputs(
        node,
        classType,
        inputs,
        assignedWidgetFieldNames,
        objectInfo,
      );

      const widgetFieldNames = getWidgetFieldNames(
        classType,
        new Set([...linkedFieldNames, ...assignedWidgetFieldNames]),
        objectInfo,
      );

      for (const fieldName of widgetFieldNames) {
        if (!fieldName) continue;
        if (widgetIndex >= node.widgets_values.length) break;
        inputs[fieldName] = node.widgets_values[widgetIndex];
        widgetIndex += 1;
        if (fieldHasControlAfterGenerate(classType, fieldName, objectInfo)) {
          widgetIndex += 1;
        }
      }
    }

    api[id] = {
      class_type: classType,
      inputs,
    };
  }

  return api;
}

function applyWidgetValuesFromNodeInputs(
  node: Record<string, any>,
  classType: string,
  inputs: Record<string, any>,
  assignedWidgetFieldNames: Set<string>,
  objectInfo?: ComfyUIObjectInfo,
): number {
  if (!Array.isArray(node.inputs) || !Array.isArray(node.widgets_values)) {
    return 0;
  }

  let widgetIndex = 0;

  for (const input of node.inputs) {
    if (!input || typeof input !== "object") continue;
    const fieldName = typeof input.name === "string" ? input.name : "";
    if (!fieldName) continue;
    if (!input.widget || typeof input.widget !== "object") continue;
    if (widgetIndex >= node.widgets_values.length) break;

    inputs[fieldName] = node.widgets_values[widgetIndex];
    assignedWidgetFieldNames.add(fieldName);
    widgetIndex += 1;

    if (fieldHasControlAfterGenerate(classType, fieldName, objectInfo)) {
      widgetIndex += 1;
    }
  }

  return widgetIndex;
}

function fieldHasControlAfterGenerate(
  classType: string,
  fieldName: string,
  objectInfo?: ComfyUIObjectInfo,
): boolean {
  const fieldSchema =
    objectInfo?.[classType]?.input?.required?.[fieldName]
    ?? objectInfo?.[classType]?.input?.optional?.[fieldName];

  if (!Array.isArray(fieldSchema)) return false;
  if (fieldSchema.length < 2 || typeof fieldSchema[1] !== "object" || !fieldSchema[1]) {
    return false;
  }

  return Boolean((fieldSchema[1] as Record<string, unknown>).control_after_generate);
}

/**
 * Normalize a workflow JSON to API format, regardless of which format it was imported in.
 * Returns { format, workflow } where 'workflow' is always in API format.
 */
export function normalizeComfyUIWorkflow(
  raw: unknown,
  objectInfo?: ComfyUIObjectInfo,
): {
  format: ComfyUIWorkflowFormat;
  graphWorkflow: Record<string, any>;
  apiWorkflow: Record<string, any>;
} {
  if (!raw || typeof raw !== "object") {
    throw new Error("normalizeComfyUIWorkflow: workflow is not an object");
  }
  const format = detectComfyUIWorkflowFormat(raw);
  if (format === "ui_workflow") {
    const apiWorkflow = pruneDisconnectedApiWorkflow(
      convertUiWorkflowToApi(raw as Record<string, any>, objectInfo),
    );
    assertApiNodeTypesAvailable(apiWorkflow, objectInfo);
    return {
      format,
      graphWorkflow: raw as Record<string, any>,
      apiWorkflow,
    };
  }
  const apiWorkflow = pruneDisconnectedApiWorkflow(raw as Record<string, any>);
  assertApiNodeTypesAvailable(apiWorkflow, objectInfo);
  return {
    format,
    graphWorkflow: apiWorkflow,
    apiWorkflow,
  };
}

function getUiNodeClassType(node: UiWorkflowNode | null | undefined): string {
  return String(node?.type ?? node?.class_type ?? "");
}

function isUiBypassNode(node: UiWorkflowNode | null | undefined): boolean {
  return Number(node?.mode) === BYPASS_NODE_MODE;
}

function countLinkedInputs(node: UiWorkflowNode): number {
  if (!Array.isArray(node.inputs)) return 0;
  let count = 0;
  for (const input of node.inputs) {
    if (input && typeof input === "object" && typeof input.link === "number") {
      count += 1;
    }
  }
  return count;
}

function getFirstLinkedInputId(node: UiWorkflowNode): number | null {
  if (!Array.isArray(node.inputs)) return null;
  for (const input of node.inputs) {
    if (input && typeof input === "object" && typeof input.link === "number") {
      return input.link;
    }
  }
  return null;
}

function shouldSkipUiNodeFromApi(
  node: UiWorkflowNode,
  classType: string,
  nodeId: string,
  outgoingLinkCounts: Map<string, number>,
  objectInfo?: ComfyUIObjectInfo,
): boolean {
  if (UI_ONLY_PASSTHROUGH_TYPES.has(classType) || isUiBypassNode(node)) {
    return true;
  }

  if (objectInfo?.[classType]) {
    return false;
  }

  const linkedInputCount = countLinkedInputs(node);
  const outgoingLinkCount = outgoingLinkCounts.get(nodeId) ?? 0;
  const widgetValueCount = Array.isArray(node.widgets_values) ? node.widgets_values.length : 0;

  return linkedInputCount === 0 && outgoingLinkCount === 0 && widgetValueCount === 0;
}

function resolveUiLinkSource(
  linkId: number,
  linkMap: Map<number, { from: [string, number] }>,
  nodesById: Map<string, UiWorkflowNode>,
  objectInfo?: ComfyUIObjectInfo,
  seenLinkIds: Set<number> = new Set(),
): [string, number] | undefined {
  if (seenLinkIds.has(linkId)) return undefined;
  seenLinkIds.add(linkId);

  const resolved = linkMap.get(linkId);
  if (!resolved) return undefined;

  const [sourceNodeId, sourceSlot] = resolved.from;
  const sourceNode = nodesById.get(sourceNodeId);
  const sourceClassType = getUiNodeClassType(sourceNode);

  if (sourceNode && UI_ONLY_PASSTHROUGH_TYPES.has(sourceClassType)) {
    const upstreamLinkId = getFirstLinkedInputId(sourceNode);
    if (typeof upstreamLinkId === "number") {
      const upstream = resolveUiLinkSource(
        upstreamLinkId,
        linkMap,
        nodesById,
        objectInfo,
        seenLinkIds,
      );
      if (upstream) {
        return upstream;
      }
    }
  }

  if (sourceNode && isUiBypassNode(sourceNode)) {
    const upstreamLinkId = getBypassInputLinkId(sourceNode, sourceSlot);
    if (typeof upstreamLinkId === "number") {
      const upstream = resolveUiLinkSource(
        upstreamLinkId,
        linkMap,
        nodesById,
        objectInfo,
        seenLinkIds,
      );
      if (upstream) {
        return upstream;
      }
    }
  }

  return resolved.from;
}

function getBypassInputLinkId(node: UiWorkflowNode, outputSlot: number): number | null {
  if (!Array.isArray(node.inputs)) return null;

  for (const input of node.inputs) {
    if (!input || typeof input !== "object") continue;
    if (typeof input.link !== "number") continue;
    if (Number(input.slot_index) === outputSlot) {
      return input.link;
    }
  }

  const indexedInput = node.inputs[outputSlot];
  if (indexedInput && typeof indexedInput === "object" && typeof indexedInput.link === "number") {
    return indexedInput.link;
  }

  const linkedInputs = node.inputs.filter(
    (input) => input && typeof input === "object" && typeof input.link === "number",
  );
  if (linkedInputs.length === 1) {
    return linkedInputs[0].link;
  }

  return null;
}

function isWorkflowLinkValue(value: unknown): value is [string, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string";
}

function nodeHasAnyLinkedInput(node: Record<string, any> | null | undefined): boolean {
  if (!node || typeof node.inputs !== "object" || !node.inputs) return false;
  return Object.values(node.inputs).some((value) => isWorkflowLinkValue(value));
}

function pruneDisconnectedApiWorkflow(workflow: Record<string, any>): Record<string, any> {
  const dependents = new Map<string, Set<string>>();

  for (const [nodeId, node] of Object.entries(workflow)) {
    const inputs =
      node && typeof node === "object" && typeof (node as any).inputs === "object" && (node as any).inputs
        ? ((node as any).inputs as Record<string, unknown>)
        : {};

    for (const value of Object.values(inputs)) {
      if (!isWorkflowLinkValue(value)) continue;
      const sourceNodeId = value[0];
      const nextDependents = dependents.get(sourceNodeId) ?? new Set<string>();
      nextDependents.add(nodeId);
      dependents.set(sourceNodeId, nextDependents);
    }
  }

  const terminalNodeIds = Object.entries(workflow)
    .filter(([nodeId, node]) =>
      (dependents.get(nodeId)?.size ?? 0) === 0 && nodeHasAnyLinkedInput(node),
    )
    .map(([nodeId]) => nodeId);

  if (terminalNodeIds.length === 0) {
    return workflow;
  }

  const keep = new Set<string>();
  const stack = [...terminalNodeIds];

  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    if (keep.has(nodeId)) continue;
    keep.add(nodeId);

    const node = workflow[nodeId];
    if (!node || typeof node.inputs !== "object" || !node.inputs) continue;

    for (const value of Object.values(node.inputs as Record<string, unknown>)) {
      if (!isWorkflowLinkValue(value)) continue;
      if (workflow[value[0]]) {
        stack.push(value[0]);
      }
    }
  }

  return Object.fromEntries(
    Object.entries(workflow).filter(([nodeId]) => keep.has(nodeId)),
  );
}

function assertApiNodeTypesAvailable(
  workflow: Record<string, any>,
  objectInfo?: ComfyUIObjectInfo,
): void {
  if (!objectInfo) return;

  const unsupportedNodes = Object.entries(workflow).flatMap(([nodeId, node]) => {
    const classType =
      node && typeof node === "object" && typeof (node as any).class_type === "string"
        ? String((node as any).class_type)
        : "";
    if (!classType || objectInfo[classType]) return [];
    return [`${classType} (#${nodeId})`];
  });

  if (unsupportedNodes.length === 0) return;

  throw new Error(
    `This workflow uses nodes that are not available on the connected ComfyUI server: ${unsupportedNodes.join(", ")}`,
  );
}

function getWidgetFieldNames(
  classType: string,
  excludedFieldNames: Set<string>,
  objectInfo?: ComfyUIObjectInfo,
): string[] {
  const schema = objectInfo?.[classType];
  const schemaFieldNames = getWidgetFieldNamesFromSchema(schema, excludedFieldNames);
  if (schemaFieldNames.length > 0) {
    return schemaFieldNames;
  }

  return (KNOWN_WIDGET_FIELD_ORDER[classType] ?? []).filter(
    (fieldName) => !excludedFieldNames.has(fieldName),
  );
}

function getWidgetFieldNamesFromSchema(
  schema: ComfyUINodeSchema | undefined,
  excludedFieldNames: Set<string>,
): string[] {
  if (!schema?.input) return [];

  const fieldNames = [
    ...getSchemaFieldOrder(schema, "required"),
    ...getSchemaFieldOrder(schema, "optional"),
  ];

  return fieldNames.filter((fieldName) => !excludedFieldNames.has(fieldName));
}

function getSchemaFieldOrder(
  schema: ComfyUINodeSchema | undefined,
  kind: "required" | "optional",
): string[] {
  const order = (schema as any)?.input_order?.[kind];
  if (Array.isArray(order)) {
    return order.filter((fieldName: unknown): fieldName is string => typeof fieldName === "string");
  }

  return Object.keys(schema?.input?.[kind] ?? {});
}
