import { get, post, put, del } from './client'

export interface McpServerProfile {
  id: string
  name: string
  transport_type: 'streamable_http' | 'sse' | 'stdio'
  url: string
  command: string
  args: string[]
  env: Record<string, string>
  has_headers: boolean
  is_enabled: boolean
  auto_connect: boolean
  metadata: Record<string, any>
  last_connected_at: number | null
  last_error: string | null
  created_at: number
  updated_at: number
}

export interface CreateMcpServerInput {
  name: string
  transport_type: 'streamable_http' | 'sse' | 'stdio'
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
  is_enabled?: boolean
  auto_connect?: boolean
  metadata?: Record<string, any>
}

export type UpdateMcpServerInput = Partial<CreateMcpServerInput>

export interface McpDiscoveredTool {
  server_id: string
  server_name: string
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface McpServerStatus {
  id: string
  connected: boolean
  tool_count: number
  tools: McpDiscoveredTool[]
  error?: string
}

export interface McpServerTestResult {
  success: boolean
  message: string
  tools: McpDiscoveredTool[]
}

export interface PaginatedResult<T> {
  data: T[]
  total: number
  limit: number
  offset: number
}

export const mcpServersApi = {
  list(params?: { limit?: number; offset?: number }) {
    return get<PaginatedResult<McpServerProfile>>('/mcp-servers', params)
  },

  get(id: string) {
    return get<McpServerProfile>(`/mcp-servers/${id}`)
  },

  create(input: CreateMcpServerInput) {
    return post<McpServerProfile>('/mcp-servers', input)
  },

  update(id: string, input: UpdateMcpServerInput) {
    return put<McpServerProfile>(`/mcp-servers/${id}`, input)
  },

  delete(id: string) {
    return del<void>(`/mcp-servers/${id}`)
  },

  connect(id: string) {
    return post<McpServerStatus>(`/mcp-servers/${id}/connect`)
  },

  disconnect(id: string) {
    return post<void>(`/mcp-servers/${id}/disconnect`)
  },

  reconnect(id: string) {
    return post<McpServerStatus>(`/mcp-servers/${id}/reconnect`)
  },

  status(id: string) {
    return get<McpServerStatus>(`/mcp-servers/${id}/status`)
  },

  test(id: string) {
    return post<McpServerTestResult>(`/mcp-servers/${id}/test`)
  },

  tools(id: string) {
    return get<{ tools: McpDiscoveredTool[] }>(`/mcp-servers/${id}/tools`)
  },

  allStatus() {
    return get<{ servers: McpServerStatus[] }>('/mcp-servers/status')
  },
}
