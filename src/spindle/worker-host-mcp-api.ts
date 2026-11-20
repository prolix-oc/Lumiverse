import { PERMISSION_DENIED_PREFIX } from "lumiverse-spindle-types";
import { getMcpClientManager } from "../services/mcp-client-manager";
import { validateMcpServerCreateInput } from "../services/mcp-server-policy";
import * as mcpServers from "../services/mcp-servers.service";
import type {
  McpServerProfile,
  McpServerStatus,
  SpindleMcpServerDTO,
  SpindleMcpServerCreateDTO,
} from "../types/mcp-server";

type McpPermission = "mcp_servers" | "mcp_servers.create";

export type WorkerHostMcpApiContext = {
  hasPermission: (permission: McpPermission) => boolean;
  resolveEffectiveUserId: (userId?: string) => string;
  enforceScopedUser: (userId: string | null | undefined) => void;
  postResponse: (message: { type: "response"; requestId: string; result?: unknown; error?: string }) => void;
};

export function toSpindleMcpServerDTO(profile: McpServerProfile): SpindleMcpServerDTO {
  const rawEnv = profile.env as unknown;
  const envKeys = Array.isArray(rawEnv)
    ? rawEnv.filter((key): key is string => typeof key === "string")
    : Object.keys(rawEnv || {});
  return {
    id: profile.id,
    name: profile.name,
    transport_type: profile.transport_type,
    has_headers: profile.has_headers,
    env_keys: envKeys,
    is_enabled: profile.is_enabled,
    auto_connect: profile.auto_connect,
    last_connected_at: profile.last_connected_at,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
  };
}

export function toSpindleMcpStatus(status: McpServerStatus): McpServerStatus {
  return {
    id: status.id,
    connected: status.connected,
    tool_count: status.tool_count,
    tools: status.tools,
    ...(!status.connected && status.error ? { error: "MCP connection failed" } : {}),
  };
}

export function isAdvertisedMcpTool(status: McpServerStatus, toolName: unknown): toolName is string {
  return typeof toolName === "string" && status.tools.some((tool) => tool.name === toolName);
}

/** Permission- and user-scoped MCP facade for untrusted extension workers. */
export class WorkerHostMcpApi {
  constructor(private readonly context: WorkerHostMcpApiContext) {}

  private requirePermission(permission: McpPermission): void {
    if (!this.context.hasPermission(permission)) {
      throw new Error(`${PERMISSION_DENIED_PREFIX} ${permission} — MCP server permission not granted`);
    }
  }

  private resolveUser(userId?: string): string {
    const resolved = this.context.resolveEffectiveUserId(userId);
    if (!resolved) throw new Error("userId is required for operator-scoped extensions");
    this.context.enforceScopedUser(resolved);
    return resolved;
  }

  private respond(requestId: string, operation: () => unknown | Promise<unknown>): void {
    void Promise.resolve()
      .then(operation)
      .then((result) => this.context.postResponse({ type: "response", requestId, result }))
      .catch((error: unknown) => this.context.postResponse({
        type: "response",
        requestId,
        error: error instanceof Error ? error.message : String(error),
      }));
  }

  handleList(requestId: string, limit = 50, offset = 0, userId?: string): void {
    this.respond(requestId, () => {
      this.requirePermission("mcp_servers");
      const resolvedUserId = this.resolveUser(userId);
      const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50;
      const safeOffset = Number.isInteger(offset) ? Math.max(offset, 0) : 0;
      const result = mcpServers.listServers(resolvedUserId, { limit: safeLimit, offset: safeOffset });
      return { ...result, data: result.data.map(toSpindleMcpServerDTO) };
    });
  }

  handleGet(requestId: string, serverId: string, userId?: string): void {
    this.respond(requestId, () => {
      this.requirePermission("mcp_servers");
      const server = mcpServers.getServer(this.resolveUser(userId), serverId);
      return server ? toSpindleMcpServerDTO(server) : null;
    });
  }

  handleCreate(requestId: string, input: SpindleMcpServerCreateDTO, userId?: string): void {
    this.respond(requestId, async () => {
      this.requirePermission("mcp_servers.create");
      const resolvedUserId = this.resolveUser(userId);
      const validated = validateMcpServerCreateInput(input);
      // Extension-created servers do not become persistent auto-connectors
      // unless the extension explicitly asks for that privileged behavior.
      if (validated.auto_connect === undefined) validated.auto_connect = false;
      if (validated.auto_connect) this.requirePermission("mcp_servers");
      const server = await mcpServers.createServer(resolvedUserId, validated);
      return toSpindleMcpServerDTO(server);
    });
  }

  handleConnect(requestId: string, serverId: string, userId?: string): void {
    this.respond(requestId, async () => {
      this.requirePermission("mcp_servers");
      const resolvedUserId = this.resolveUser(userId);
      const server = mcpServers.getServer(resolvedUserId, serverId);
      if (!server) throw new Error("MCP server not found");
      if (!server.is_enabled) throw new Error("MCP server is disabled");
      const existing = getMcpClientManager().getStatus(resolvedUserId, serverId);
      if (existing) return toSpindleMcpStatus(existing);
      // McpClientManager is the sole transport boundary and re-applies both
      // private-network and stdio launch policy on every connection.
      return toSpindleMcpStatus(await getMcpClientManager().connect(resolvedUserId, server));
    });
  }

  handleStatus(requestId: string, serverId: string, userId?: string): void {
    this.respond(requestId, () => {
      this.requirePermission("mcp_servers");
      const resolvedUserId = this.resolveUser(userId);
      const server = mcpServers.getServer(resolvedUserId, serverId);
      if (!server) throw new Error("MCP server not found");
      const status = getMcpClientManager().getStatus(resolvedUserId, serverId);
      return status ? toSpindleMcpStatus(status) : {
        id: serverId,
        connected: false,
        tool_count: 0,
        tools: [],
        ...(server.last_error ? { error: "MCP connection failed" } : {}),
      };
    });
  }

  handleListTools(requestId: string, serverId: string, userId?: string): void {
    this.respond(requestId, () => {
      this.requirePermission("mcp_servers");
      const resolvedUserId = this.resolveUser(userId);
      if (!mcpServers.getServer(resolvedUserId, serverId)) throw new Error("MCP server not found");
      return getMcpClientManager().getStatus(resolvedUserId, serverId)?.tools || [];
    });
  }

  handleCallTool(
    requestId: string,
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number | undefined,
    userId?: string,
  ): void {
    this.respond(requestId, async () => {
      this.requirePermission("mcp_servers");
      const resolvedUserId = this.resolveUser(userId);
      const server = mcpServers.getServer(resolvedUserId, serverId);
      if (!server || !server.is_enabled) throw new Error("MCP server not found or disabled");
      const status = getMcpClientManager().getStatus(resolvedUserId, serverId);
      if (!status) throw new Error("MCP server is not connected");
      if (!isAdvertisedMcpTool(status, toolName)) {
        throw new Error("MCP tool is not advertised by this server");
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("MCP tool arguments must be an object");
      const serializedArgs = JSON.stringify(args);
      if (Buffer.byteLength(serializedArgs, "utf8") > 1_048_576) throw new Error("MCP tool arguments are too large");
      const safeTimeout = timeoutMs === undefined
        ? 30_000
        : Math.min(Math.max(Number.isFinite(timeoutMs) ? timeoutMs : 30_000, 1_000), 120_000);
      return getMcpClientManager().callTool(resolvedUserId, serverId, toolName, args, safeTimeout);
    });
  }
}
