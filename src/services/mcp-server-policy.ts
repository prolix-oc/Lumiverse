import type { CreateMcpServerInput, McpTransportType } from "../types/mcp-server";
import { assertStdioLaunchAllowed } from "./mcp-stdio-policy";

const TRANSPORT_TYPES = new Set<McpTransportType>(["streamable_http", "sse", "stdio"]);
const MAX_NAME_LENGTH = 200;
const MAX_URL_LENGTH = 4_096;
const MAX_SECRET_ENTRIES = 128;
const MAX_SECRET_KEY_LENGTH = 256;
const MAX_SECRET_VALUE_LENGTH = 16_384;
const MAX_METADATA_BYTES = 32_768;

function stringMap(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object containing string values`);
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_SECRET_ENTRIES) throw new Error(`${label} has too many entries`);
  const result: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (!key || key.length > MAX_SECRET_KEY_LENGTH || /[\0\r\n]/.test(key)) {
      throw new Error(`${label} contains an invalid key`);
    }
    if (typeof entry !== "string") throw new Error(`${label} must contain only string values`);
    if (entry.length > MAX_SECRET_VALUE_LENGTH || /\0/.test(entry)) {
      throw new Error(`${label} contains an invalid value`);
    }
    result[key] = entry;
  }
  return result;
}

function booleanValue(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function metadataValue(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("metadata must be an object");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("metadata must be JSON serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_METADATA_BYTES) {
    throw new Error("metadata is too large");
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

/**
 * Validate MCP creation input at every trust boundary. Transport execution
 * still goes through McpClientManager, which re-applies SSRF and stdio policy.
 */
export function validateMcpServerCreateInput(value: unknown): CreateMcpServerInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP server input must be an object");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.name !== "string" || !input.name.trim()) {
    throw new Error("name is required");
  }
  const name = input.name.trim();
  if (name.length > MAX_NAME_LENGTH) throw new Error("name is too long");
  if (typeof input.transport_type !== "string" || !TRANSPORT_TYPES.has(input.transport_type as McpTransportType)) {
    throw new Error(`transport_type must be one of: ${[...TRANSPORT_TYPES].join(", ")}`);
  }
  const transportType = input.transport_type as McpTransportType;

  let url: string | undefined;
  let command: string | undefined;
  let args: string[] | undefined;
  if (transportType === "stdio") {
    command = typeof input.command === "string" ? input.command : "";
    args = input.args === undefined ? [] : input.args as string[];
    assertStdioLaunchAllowed(command, args);
  } else {
    if (typeof input.url !== "string" || !input.url.trim()) throw new Error("url is required for HTTP MCP servers");
    url = input.url.trim();
    if (url.length > MAX_URL_LENGTH) throw new Error("url is too long");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("url must be a valid absolute URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("MCP server URL must use http or https");
    }
  }

  const env = stringMap(input.env, "env");
  const headers = stringMap(input.headers, "headers");
  const isEnabled = booleanValue(input.is_enabled, "is_enabled");
  const autoConnect = booleanValue(input.auto_connect, "auto_connect");
  const metadata = metadataValue(input.metadata);

  return {
    name,
    transport_type: transportType,
    ...(url !== undefined ? { url } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(isEnabled !== undefined ? { is_enabled: isEnabled } : {}),
    ...(autoConnect !== undefined ? { auto_connect: autoConnect } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}
