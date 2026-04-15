import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { validateHost } from "../utils/safe-fetch";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as mcpServersSvc from "./mcp-servers.service";
import type { McpServerProfile, McpDiscoveredTool, McpServerStatus } from "../types/mcp-server";

const ALLOW_PRIVATE = process.env.ALLOW_MCP_PRIVATE_NETWORKS === "true";

/**
 * Whitelist of allowed stdio command basenames. MCP servers are spawned as
 * child processes; without a whitelist any authenticated user who can create
 * an MCP server profile gets arbitrary OS command execution by setting
 * command="/bin/bash". Operators who legitimately need to launch other
 * binaries can extend this list via MCP_STDIO_ALLOWED_COMMANDS (comma-
 * separated basenames).
 */
const DEFAULT_STDIO_ALLOWED = [
  "node", "bun", "deno", "python", "python3",
  "npx", "uvx", "uv", "pipx", "pnpm", "yarn",
];
const STDIO_ALLOWED_COMMANDS = new Set(
  (process.env.MCP_STDIO_ALLOWED_COMMANDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .concat(DEFAULT_STDIO_ALLOWED),
);

function commandBasename(command: string): string {
  // Strip path components (handles both / and \ separators).
  const lastSlash = Math.max(command.lastIndexOf("/"), command.lastIndexOf("\\"));
  const base = lastSlash >= 0 ? command.slice(lastSlash + 1) : command;
  // Strip a single trailing .exe (Windows) for the comparison.
  return base.toLowerCase().replace(/\.exe$/, "");
}

function assertStdioCommandAllowed(command: string): void {
  if (!command || typeof command !== "string") {
    throw new Error("MCP stdio command is required");
  }
  // Reject obvious shell-meta or argument-injection attempts in the command itself.
  if (/[;&|`$<>\n\r]/.test(command)) {
    throw new Error("MCP stdio command contains disallowed characters");
  }
  const base = commandBasename(command);
  if (!STDIO_ALLOWED_COMMANDS.has(base)) {
    throw new Error(
      `MCP stdio command "${base}" is not in the allowlist. ` +
        `Set MCP_STDIO_ALLOWED_COMMANDS to extend it.`,
    );
  }
}

interface McpClientEntry {
  client: Client;
  transport: Transport;
  tools: McpDiscoveredTool[];
  serverId: string;
  serverName: string;
  userId: string;
}

class McpClientManager {
  private clients = new Map<string, McpClientEntry>();

  private key(userId: string, serverId: string): string {
    return `${userId}:${serverId}`;
  }

  async connect(userId: string, server: McpServerProfile): Promise<McpServerStatus> {
    const k = this.key(userId, server.id);

    // Disconnect existing if re-connecting
    if (this.clients.has(k)) {
      await this.disconnect(userId, server.id);
    }

    let transport: Transport;

    try {
      if (server.transport_type === "stdio") {
        transport = await this.buildStdioTransport(userId, server);
      } else {
        transport = await this.buildHttpTransport(userId, server);
      }
    } catch (err: any) {
      const error = err.message || "Failed to build transport";
      mcpServersSvc.updateServerStatus(server.id, userId, { last_error: error });
      eventBus.emit(EventType.MCP_SERVER_ERROR, { id: server.id, name: server.name, error }, userId);
      return { id: server.id, connected: false, tool_count: 0, tools: [], error };
    }

    const client = new Client({ name: "lumiverse", version: "1.0.0" });

    client.onerror = (err) => {
      console.error(`[MCP] Transport error for "${server.name}":`, err);
      eventBus.emit(EventType.MCP_SERVER_ERROR, { id: server.id, name: server.name, error: String(err) }, userId);
    };

    client.onclose = () => {
      if (this.clients.has(k)) {
        this.clients.delete(k);
        mcpServersSvc.updateServerStatus(server.id, userId, { last_error: "Connection closed" });
        eventBus.emit(EventType.MCP_SERVER_DISCONNECTED, { id: server.id, name: server.name, reason: "closed" }, userId);
      }
    };

    try {
      await client.connect(transport);
    } catch (err: any) {
      const error = err.message || "Failed to connect";
      mcpServersSvc.updateServerStatus(server.id, userId, { last_error: error });
      eventBus.emit(EventType.MCP_SERVER_ERROR, { id: server.id, name: server.name, error }, userId);
      return { id: server.id, connected: false, tool_count: 0, tools: [], error };
    }

    // Discover tools (paginated)
    const tools = await this.discoverTools(client, server);

    const entry: McpClientEntry = {
      client,
      transport,
      tools,
      serverId: server.id,
      serverName: server.name,
      userId,
    };
    this.clients.set(k, entry);

    mcpServersSvc.updateServerStatus(server.id, userId, {
      last_connected_at: Math.floor(Date.now() / 1000),
      last_error: null,
    });

    const status: McpServerStatus = {
      id: server.id,
      connected: true,
      tool_count: tools.length,
      tools,
    };

    eventBus.emit(EventType.MCP_SERVER_CONNECTED, { id: server.id, name: server.name, toolCount: tools.length, tools }, userId);
    return status;
  }

  async disconnect(userId: string, serverId: string): Promise<void> {
    const k = this.key(userId, serverId);
    const entry = this.clients.get(k);
    if (!entry) return;

    this.clients.delete(k);
    try {
      await entry.client.close();
    } catch (err) {
      console.error(`[MCP] Error closing client "${entry.serverName}":`, err);
    }

    eventBus.emit(
      EventType.MCP_SERVER_DISCONNECTED,
      { id: serverId, name: entry.serverName, reason: "manual" },
      userId
    );
  }

  async reconnect(userId: string, server: McpServerProfile): Promise<McpServerStatus> {
    await this.disconnect(userId, server.id);
    return this.connect(userId, server);
  }

  getStatus(userId: string, serverId: string): McpServerStatus | null {
    const entry = this.clients.get(this.key(userId, serverId));
    if (!entry) return null;
    return {
      id: serverId,
      connected: true,
      tool_count: entry.tools.length,
      tools: entry.tools,
    };
  }

  getAllConnected(userId: string): McpServerStatus[] {
    const results: McpServerStatus[] = [];
    for (const [k, entry] of this.clients) {
      if (entry.userId === userId) {
        results.push({
          id: entry.serverId,
          connected: true,
          tool_count: entry.tools.length,
          tools: entry.tools,
        });
      }
    }
    return results;
  }

  getDiscoveredTools(userId: string): McpDiscoveredTool[] {
    const tools: McpDiscoveredTool[] = [];
    for (const [, entry] of this.clients) {
      if (entry.userId === userId) {
        tools.push(...entry.tools);
      }
    }
    return tools;
  }

  async callTool(
    userId: string,
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs = 30_000
  ): Promise<string> {
    const entry = this.clients.get(this.key(userId, serverId));
    if (!entry) throw new Error(`MCP server not connected: ${serverId}`);

    const resultPromise = entry.client.callTool({ name: toolName, arguments: args });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`MCP tool "${toolName}" timed out after ${timeoutMs}ms`)), timeoutMs)
    );

    const result = await Promise.race([resultPromise, timeoutPromise]);

    if (result.isError) {
      const errContent = Array.isArray(result.content)
        ? result.content.map((c: any) => c.text || JSON.stringify(c)).join("\n")
        : String(result.content);
      throw new Error(`MCP tool error: ${errContent}`);
    }

    // Serialize content blocks to string
    if (Array.isArray(result.content)) {
      return result.content
        .map((c: any) => {
          if (c.type === "text") return c.text;
          return JSON.stringify(c);
        })
        .join("\n");
    }

    return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
  }

  async autoConnectAll(): Promise<void> {
    const servers = mcpServersSvc.getAutoConnectServers();
    if (servers.length === 0) return;

    console.log(`[MCP] Auto-connecting ${servers.length} server(s)...`);

    for (const server of servers) {
      try {
        const status = await this.connect(server.user_id as any, server);
        if (status.connected) {
          console.log(`[MCP] Connected to "${server.name}" — ${status.tool_count} tool(s)`);
        } else {
          console.warn(`[MCP] Failed to connect to "${server.name}": ${status.error}`);
        }
      } catch (err) {
        console.error(`[MCP] Auto-connect failed for "${server.name}":`, err);
      }
    }
  }

  async disconnectAll(userId?: string): Promise<void> {
    const toDisconnect: [string, string][] = [];
    for (const [, entry] of this.clients) {
      if (!userId || entry.userId === userId) {
        toDisconnect.push([entry.userId, entry.serverId]);
      }
    }
    for (const [uid, sid] of toDisconnect) {
      await this.disconnect(uid, sid);
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async buildHttpTransport(userId: string, server: McpServerProfile): Promise<Transport> {
    const url = new URL(server.url);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Unsupported protocol: ${url.protocol}`);
    }

    if (!ALLOW_PRIVATE) {
      await validateHost(url.hostname);
    }

    const headers = await mcpServersSvc.getServerHeaders(userId, server.id);
    const requestInit: RequestInit = {};
    if (Object.keys(headers).length > 0) {
      requestInit.headers = headers;
    }

    if (server.transport_type === "sse") {
      return new SSEClientTransport(url, { requestInit });
    }

    return new StreamableHTTPClientTransport(url, { requestInit });
  }

  private async buildStdioTransport(userId: string, server: McpServerProfile): Promise<Transport> {
    assertStdioCommandAllowed(server.command);

    const envValues = await mcpServersSvc.getServerEnv(userId, server.id);

    // Build restricted env: declared vars + PATH only
    const childEnv: Record<string, string> = {};
    if (process.env.PATH) childEnv.PATH = process.env.PATH;
    for (const [key, value] of Object.entries(envValues)) {
      childEnv[key] = value;
    }

    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: childEnv,
    });
  }

  private async discoverTools(client: Client, server: McpServerProfile): Promise<McpDiscoveredTool[]> {
    const allTools: McpDiscoveredTool[] = [];

    try {
      let cursor: string | undefined;
      do {
        const response = await client.listTools({ cursor });
        for (const tool of response.tools) {
          allTools.push({
            server_id: server.id,
            server_name: server.name,
            name: tool.name,
            description: tool.description || "",
            input_schema: (tool.inputSchema as Record<string, unknown>) || {},
          });
        }
        cursor = response.nextCursor;
      } while (cursor);
    } catch (err) {
      // Server may not support tools capability — return empty
      console.warn(`[MCP] Tool discovery failed for "${server.name}":`, err);
    }

    return allTools;
  }
}

// Singleton
let _manager: McpClientManager | null = null;

export function getMcpClientManager(): McpClientManager {
  if (!_manager) _manager = new McpClientManager();
  return _manager;
}
