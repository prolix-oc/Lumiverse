import type { RuntimeCouncilToolDefinition } from "./tool-runtime";
import { getMcpClientManager } from "../mcp-client-manager";

/**
 * Convert discovered MCP tools into CouncilToolDefinition format
 * so they appear alongside built-in, DLC, and extension tools.
 *
 * Qualified name format: `mcp:{serverIdPrefix8}:{toolName}`
 */
export function getMcpToolsAsCouncilTools(userId: string): RuntimeCouncilToolDefinition[] {
  const manager = getMcpClientManager();
  const discoveredTools = manager.getDiscoveredTools(userId);

  return discoveredTools.map((tool): RuntimeCouncilToolDefinition => ({
    name: `mcp:${tool.server_id.slice(0, 8)}:${tool.name}`,
    displayName: tool.name,
    description: tool.description,
    category: "extension",
    execution: "mcp",
    prompt: tool.description,
    inputSchema: tool.input_schema,
    argsSchema: tool.input_schema,
    storeInDeliberation: true,
    extensionName: `MCP: ${tool.server_name}`,
  }));
}

/**
 * Parse a qualified MCP tool name and find the matching connected server.
 * Returns { serverId, toolName } or null if not found.
 */
export function parseMcpToolName(
  userId: string,
  qualifiedName: string
): { serverId: string; toolName: string } | null {
  // Format: mcp:{serverIdPrefix8}:{toolName}
  const parts = qualifiedName.split(":");
  if (parts.length < 3 || parts[0] !== "mcp") return null;

  const serverIdPrefix = parts[1];
  const toolName = parts.slice(2).join(":");

  const manager = getMcpClientManager();
  const connected = manager.getAllConnected(userId);
  const match = connected.find((s) => s.id.startsWith(serverIdPrefix));
  if (!match) return null;

  return { serverId: match.id, toolName };
}
