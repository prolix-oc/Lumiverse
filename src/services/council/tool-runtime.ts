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
    gender_identity?: 0 | 1 | 2 | 3 | null;
  } | null,
): CouncilMemberContext {
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
    // The shared spindle types package still narrows this field to 0|1|2.
    // Runtime values now allow 3 for "any", so cast at the boundary until the package catches up.
    genderIdentity: (item?.gender_identity ?? 3) as CouncilMemberContext["genderIdentity"],
  };
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
  return toolRegistry.getTool(name);
}

export async function invokeExtensionCouncilTool(
  extensionId: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  councilMember?: CouncilMemberContext,
  contextMessages?: LlmMessage[],
): Promise<string> {
  const host = getWorkerHost(extensionId);
  if (!host) {
    throw new Error(`Extension worker '${extensionId}' is not running`);
  }
  return host.invokeExtensionTool(toolName, args, timeoutMs, councilMember, contextMessages);
}
