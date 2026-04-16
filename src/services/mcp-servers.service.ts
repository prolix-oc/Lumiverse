import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as secretsSvc from "./secrets.service";
import type {
  McpServerProfile,
  CreateMcpServerInput,
  UpdateMcpServerInput,
} from "../types/mcp-server";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery } from "./pagination";

/** Secret key for a server's encrypted headers. */
export function mcpServerHeadersKey(id: string): string {
  return `mcp_server_${id}_headers`;
}

/** Secret key for a server's encrypted stdio env values. */
export function mcpServerEnvKey(id: string): string {
  return `mcp_server_${id}_env`;
}

function rowToProfile(row: any): McpServerProfile {
  return {
    ...row,
    is_enabled: !!row.is_enabled,
    auto_connect: !!row.auto_connect,
    has_headers: !!row.has_headers,
    args: JSON.parse(row.args || "[]"),
    env: JSON.parse(row.env || "{}"),
    metadata: JSON.parse(row.metadata || "{}"),
  };
}

export function listServers(userId: string, pagination: PaginationParams): PaginatedResult<McpServerProfile> {
  return paginatedQuery(
    "SELECT * FROM mcp_servers WHERE user_id = ? ORDER BY updated_at DESC",
    "SELECT COUNT(*) as count FROM mcp_servers WHERE user_id = ?",
    [userId],
    pagination,
    rowToProfile
  );
}

export function getServer(userId: string, id: string): McpServerProfile | null {
  const row = getDb()
    .query("SELECT * FROM mcp_servers WHERE id = ? AND user_id = ?")
    .get(id, userId) as any;
  return row ? rowToProfile(row) : null;
}

export function getEnabledServers(userId: string): McpServerProfile[] {
  const rows = getDb()
    .query("SELECT * FROM mcp_servers WHERE user_id = ? AND is_enabled = 1 ORDER BY name ASC")
    .all(userId) as any[];
  return rows.map(rowToProfile);
}

export function getAutoConnectServers(): (McpServerProfile & { user_id: string })[] {
  const rows = getDb()
    .query("SELECT * FROM mcp_servers WHERE is_enabled = 1 AND auto_connect = 1 ORDER BY user_id, name ASC")
    .all() as any[];
  return rows.map((r) => ({ ...rowToProfile(r), user_id: r.user_id }));
}

export async function createServer(
  userId: string,
  input: CreateMcpServerInput
): Promise<McpServerProfile> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  let hasHeaders = 0;
  if (input.headers && Object.keys(input.headers).length > 0) {
    await secretsSvc.putSecret(userId, mcpServerHeadersKey(id), JSON.stringify(input.headers));
    hasHeaders = 1;
  }

  if (input.env && Object.keys(input.env).length > 0) {
    await secretsSvc.putSecret(userId, mcpServerEnvKey(id), JSON.stringify(input.env));
  }

  getDb()
    .query(
      `INSERT INTO mcp_servers
        (id, user_id, name, transport_type, url, command, args, env, has_headers, is_enabled, auto_connect, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      userId,
      input.name,
      input.transport_type,
      input.url || "",
      input.command || "",
      JSON.stringify(input.args || []),
      JSON.stringify(Object.keys(input.env || {})),  // store key names only in DB
      hasHeaders,
      input.is_enabled !== false ? 1 : 0,
      input.auto_connect !== false ? 1 : 0,
      JSON.stringify(input.metadata || {}),
      now,
      now
    );

  const profile = getServer(userId, id)!;
  eventBus.emit(EventType.MCP_SERVER_CHANGED, { id, profile }, userId);
  return profile;
}

export async function updateServer(
  userId: string,
  id: string,
  input: UpdateMcpServerInput
): Promise<McpServerProfile | null> {
  const existing = getServer(userId, id);
  if (!existing) return null;

  if (input.headers !== undefined) {
    if (input.headers && Object.keys(input.headers).length > 0) {
      await secretsSvc.putSecret(userId, mcpServerHeadersKey(id), JSON.stringify(input.headers));
      getDb()
        .query("UPDATE mcp_servers SET has_headers = 1 WHERE id = ? AND user_id = ?")
        .run(id, userId);
    } else {
      secretsSvc.deleteSecret(userId, mcpServerHeadersKey(id));
      getDb()
        .query("UPDATE mcp_servers SET has_headers = 0 WHERE id = ? AND user_id = ?")
        .run(id, userId);
    }
  }

  if (input.env !== undefined) {
    if (input.env && Object.keys(input.env).length > 0) {
      await secretsSvc.putSecret(userId, mcpServerEnvKey(id), JSON.stringify(input.env));
    } else {
      secretsSvc.deleteSecret(userId, mcpServerEnvKey(id));
    }
  }

  const fields: string[] = [];
  const values: any[] = [];

  if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name); }
  if (input.transport_type !== undefined) { fields.push("transport_type = ?"); values.push(input.transport_type); }
  if (input.url !== undefined) { fields.push("url = ?"); values.push(input.url); }
  if (input.command !== undefined) { fields.push("command = ?"); values.push(input.command); }
  if (input.args !== undefined) { fields.push("args = ?"); values.push(JSON.stringify(input.args)); }
  if (input.env !== undefined) { fields.push("env = ?"); values.push(JSON.stringify(Object.keys(input.env))); }
  if (input.is_enabled !== undefined) { fields.push("is_enabled = ?"); values.push(input.is_enabled ? 1 : 0); }
  if (input.auto_connect !== undefined) { fields.push("auto_connect = ?"); values.push(input.auto_connect ? 1 : 0); }
  if (input.metadata !== undefined) { fields.push("metadata = ?"); values.push(JSON.stringify(input.metadata)); }

  if (fields.length === 0 && input.headers === undefined && input.env === undefined) return existing;

  fields.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);
  values.push(userId);

  getDb()
    .query(`UPDATE mcp_servers SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`)
    .run(...values);

  const updated = getServer(userId, id)!;
  eventBus.emit(EventType.MCP_SERVER_CHANGED, { id, profile: updated }, userId);
  return updated;
}

export async function deleteServer(userId: string, id: string): Promise<boolean> {
  const deleted =
    getDb()
      .query("DELETE FROM mcp_servers WHERE id = ? AND user_id = ?")
      .run(id, userId).changes > 0;
  if (deleted) {
    secretsSvc.deleteSecret(userId, mcpServerHeadersKey(id));
    secretsSvc.deleteSecret(userId, mcpServerEnvKey(id));
    eventBus.emit(EventType.MCP_SERVER_CHANGED, { id, deleted: true }, userId);
  }
  return deleted;
}

/** Retrieve encrypted headers for a server. */
export async function getServerHeaders(userId: string, id: string): Promise<Record<string, string>> {
  const json = await secretsSvc.getSecret(userId, mcpServerHeadersKey(id));
  if (!json) return {};
  try { return JSON.parse(json); } catch { return {}; }
}

/** Retrieve encrypted env values for a stdio server. */
export async function getServerEnv(userId: string, id: string): Promise<Record<string, string>> {
  const json = await secretsSvc.getSecret(userId, mcpServerEnvKey(id));
  if (!json) return {};
  try { return JSON.parse(json); } catch { return {}; }
}

export function updateServerStatus(
  id: string,
  userId: string,
  status: { last_connected_at?: number; last_error?: string | null }
): void {
  const fields: string[] = ["updated_at = ?"];
  const values: any[] = [Math.floor(Date.now() / 1000)];

  if (status.last_connected_at !== undefined) {
    fields.push("last_connected_at = ?");
    values.push(status.last_connected_at);
  }
  if (status.last_error !== undefined) {
    fields.push("last_error = ?");
    values.push(status.last_error);
  }

  values.push(id);
  values.push(userId);

  getDb()
    .query(`UPDATE mcp_servers SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`)
    .run(...values);
}
