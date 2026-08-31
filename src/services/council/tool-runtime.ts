import type {
  CouncilMember,
  CouncilMemberContext,
  CouncilToolDefinition,
  ToolRegistration,
} from "lumiverse-spindle-types";
import type { LlmMessage } from "../../llm/types";
import { toolRegistry } from "../../spindle/tool-registry";
import { getWorkerHost } from "../../spindle/lifecycle";
import { parseMcpToolName } from "./mcp-tools";

export type RuntimeCouncilToolDefinition = Omit<CouncilToolDefinition, "prompt" | "inputSchema"> & {
  execution?: RuntimeCouncilToolExecution;
  prompt?: string;
  inputSchema?: Record<string, unknown>;
  argsSchema?: Record<string, unknown>;
  strict?: boolean;
  inputExamples?: Array<Record<string, unknown>>;
  planningGuidance?: string;
};

export type RuntimeCouncilToolExecution = "llm" | "host" | "extension" | "mcp";

const EMPTY_TOOL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
  required: [],
};

function normalizeToolJsonSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeToolJsonSchemaValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const input = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input)) {
    normalized[key] = normalizeToolJsonSchemaValue(child);
  }

  return normalized;
}

export function normalizeToolJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return normalizeToolJsonSchemaValue(schema) as Record<string, unknown>;
}

export function buildCouncilMemberContext(
  member: CouncilMember,
  item: {
    avatar_url?: string | null;
    definition?: string | null;
    personality?: string | null;
    behavior?: string | null;
    gender_identity?: unknown;
  } | null,
): CouncilMemberContext {
  const rawGenderIdentity = item?.gender_identity;
  const genderIdentity =
    rawGenderIdentity === undefined || rawGenderIdentity === null
      ? 3
      : rawGenderIdentity === 0 ||
          rawGenderIdentity === 1 ||
          rawGenderIdentity === 2 ||
          rawGenderIdentity === 3
        ? rawGenderIdentity
        : (() => {
            throw new Error("Invalid Council member context gender identity");
          })();

  // The public package predates the runtime's explicit "any" (3) value.
  // Keep the boundary cast named and narrow only after exhaustive validation.
  const wireGenderIdentity =
    genderIdentity as unknown as CouncilMemberContext["genderIdentity"];
  return {
    memberId: member.id,
    itemId: member.itemId,
    packId: member.packId,
    packName: member.packName,
    name: member.itemName,
    role: member.role ?? "",
    chance: member.chance,
    avatarUrl: item?.avatar_url ?? null,
    definition: item?.definition ?? "",
    personality: item?.personality ?? "",
    behavior: item?.behavior ?? "",
    genderIdentity: wireGenderIdentity,
  };
}

export function validateCouncilMemberContext(
  context: CouncilMemberContext,
): CouncilMemberContext {
  const candidate: unknown = context;
  let genderIdentity: unknown;
  if (candidate && typeof candidate === "object" && "genderIdentity" in candidate) {
    genderIdentity = candidate.genderIdentity;
  }
  if (
    genderIdentity !== 0 &&
    genderIdentity !== 1 &&
    genderIdentity !== 2 &&
    genderIdentity !== 3
  ) {
    throw new Error("Invalid Council member context gender identity");
  }
  return context;
}

export function getCouncilToolExecution(
  userId: string,
  tool: RuntimeCouncilToolDefinition,
): RuntimeCouncilToolExecution {
  if (tool.execution) return tool.execution;
  if (parseMcpToolName(userId, tool.name)) return "mcp";
  if (toolRegistry.getTool(tool.name)?.extension_id) return "extension";
  return "llm";
}

export function getCouncilToolArgsSchema(
  userId: string,
  tool: RuntimeCouncilToolDefinition,
): Record<string, unknown> | null {
  if (tool.argsSchema && Object.keys(tool.argsSchema).length > 0) {
    return normalizeToolJsonSchema(tool.argsSchema);
  }

  const execution = getCouncilToolExecution(userId, tool);
  if (execution === "host" || execution === "extension" || execution === "mcp") {
    return tool.inputSchema && Object.keys(tool.inputSchema).length > 0
      ? normalizeToolJsonSchema(tool.inputSchema)
      : { ...EMPTY_TOOL_SCHEMA };
  }

  return null;
}

export function isCouncilToolInlineCallable(
  userId: string,
  tool: RuntimeCouncilToolDefinition,
): boolean {
  return getCouncilToolExecution(userId, tool) !== "llm" && getCouncilToolArgsSchema(userId, tool) !== null;
}
export function getExtensionToolRegistration(name: string): ToolRegistration | undefined {
  // Qualified lookups are authoritative. The bare-name fallback remains for
  // legacy Council sidecar calls, but must never reinterpret a mapped name.
  return toolRegistry.getToolQualified(name) ?? toolRegistry.getTool(name);
}

export async function invokeExtensionCouncilTool(
  extensionId: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  councilMember?: CouncilMemberContext,
  contextMessages?: LlmMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const host = getWorkerHost(extensionId);
  if (!host) {
    throw new Error(`Extension worker '${extensionId}' is not running`);
  }
  if (councilMember) validateCouncilMemberContext(councilMember);
  return host.invokeExtensionTool(
    toolName,
    args,
    timeoutMs,
    councilMember,
    contextMessages,
    signal,
  );
}
