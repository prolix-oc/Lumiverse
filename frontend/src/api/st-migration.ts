import { get, post } from './client'

// ─── Connection config types ────────────────────────────────────────────────

export interface LocalConnectionConfig {
  type: 'local'
}

export interface SFTPConnectionConfig {
  type: 'sftp'
  host: string
  port?: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
}

export interface SMBConnectionConfig {
  type: 'smb'
  host: string
  share: string
  port?: number
  username?: string
  password?: string
  domain?: string
}

export type FileConnectionConfig =
  | LocalConnectionConfig
  | SFTPConnectionConfig
  | SMBConnectionConfig

// ─── API result types ───────────────────────────────────────────────────────

export interface BrowseResult {
  path: string
  parent: string | null
  entries: { name: string }[]
}

export interface ValidateResult {
  valid: boolean
  basePath?: string
  stUsers?: string[]
  layout?: 'multi-user' | 'legacy'
  error?: string
}

export interface ScanResult {
  characters: number
  chatDirs: number
  totalChatFiles: number
  groupChats: number
  groupChatFiles: number
  worldBooks: number
  personas: number
}

export interface MigrationScope {
  characters: boolean
  worldBooks: boolean
  personas: boolean
  chats: boolean
  groupChats: boolean
}

export interface ExecuteResult {
  migrationId: string
}

export interface MigrationStatus {
  status: 'idle' | 'running' | 'completed' | 'failed'
  migrationId?: string
  phase?: string
  startedAt?: number
  results?: Record<string, any>
  error?: string
}

export interface TestConnectionResult {
  success: boolean
  type: string
  canAccess?: boolean
  error?: string
}

// ─── API methods ────────────────────────────────────────────────────────────

export const stMigrationApi = {
  browse(path?: string, connection?: FileConnectionConfig) {
    const params: Record<string, string> = {}
    if (path) params.path = path
    if (connection && connection.type !== 'local') {
      params.connection = JSON.stringify(connection)
    }
    return get<BrowseResult>('/st-migration/browse', params)
  },

  validate(path: string, connection?: FileConnectionConfig) {
    return post<ValidateResult>('/st-migration/validate', {
      path,
      ...(connection && connection.type !== 'local' ? { connection } : {}),
    })
  },

  scan(dataDir: string, connection?: FileConnectionConfig) {
    return post<ScanResult>('/st-migration/scan', {
      dataDir,
      ...(connection && connection.type !== 'local' ? { connection } : {}),
    })
  },

  execute(params: {
    dataDir: string
    targetUserId: string
    scope: MigrationScope
    connection?: FileConnectionConfig
  }) {
    return post<ExecuteResult>('/st-migration/execute', params)
  },

  testConnection(connection: FileConnectionConfig, path?: string) {
    return post<TestConnectionResult>('/st-migration/test-connection', {
      connection,
      ...(path ? { path } : {}),
    })
  },

  status() {
    return get<MigrationStatus>('/st-migration/status')
  },

  connectionTypes() {
    return get<{ types: Array<FileConnectionConfig['type']> }>('/st-migration/connection-types')
  },
}
