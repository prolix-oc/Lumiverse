export type McpTransportType = "streamable_http" | "sse" | "stdio";

export interface McpServerProfile {
  id: string;
  name: string;
  transport_type: McpTransportType;
  url: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  has_headers: boolean;
  is_enabled: boolean;
  auto_connect: boolean;
  metadata: Record<string, any>;
  last_connected_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateMcpServerInput {
  name: string;
  transport_type: McpTransportType;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Transient — encrypted into secrets table as JSON, never persisted in DB */
  headers?: Record<string, string>;
  is_enabled?: boolean;
  auto_connect?: boolean;
  metadata?: Record<string, any>;
}

export type UpdateMcpServerInput = Partial<CreateMcpServerInput>;

export interface McpDiscoveredTool {
  server_id: string;
  server_name: string;
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface McpServerStatus {
  id: string;
  connected: boolean;
  tool_count: number;
  tools: McpDiscoveredTool[];
  error?: string;
}
