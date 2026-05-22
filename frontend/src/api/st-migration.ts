import { get, post, put, del, upload } from './client'
import type { TagLibraryImportResult } from '@/types/api'

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

export interface GoogleDriveConnectionConfig {
  type: 'google-drive'
  accessToken: string
}

export interface DropboxConnectionConfig {
  type: 'dropbox'
  accessToken: string
}

export type FileConnectionConfig =
  | LocalConnectionConfig
  | SFTPConnectionConfig
  | SMBConnectionConfig
  | GoogleDriveConnectionConfig
  | DropboxConnectionConfig

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
  progress?: {
    phase: string
    label: string
    current: number
    total: number
    updatedAt: number
  }
  recentLogs?: Array<{
    level: 'info' | 'warn' | 'error'
    message: string
    timestamp: number
  }>
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

  importTagLibrary(file: File, targetUserId: string) {
    const form = new FormData()
    form.append('file', file)
    form.append('targetUserId', targetUserId)
    return upload<TagLibraryImportResult>('/st-migration/tag-library/import', form, { timeout: 0 })
  },

  connectionTypes() {
    return get<{ types: Array<FileConnectionConfig['type']> }>('/st-migration/connection-types')
  },
}

// ─── Google Drive API ───────────────────────────────────────────────────────

export const googleDriveApi = {
  initiateAuth() {
    const callbackUrl = `${window.location.origin}/api/v1/google-drive/oauth-landing`
    return get<{ auth_url: string; session_token: string }>('/google-drive/auth', { callback_url: callbackUrl })
  },

  completeAuth(sessionToken: string, code: string) {
    return post<{ success: boolean }>('/google-drive/auth/callback', {
      session_token: sessionToken,
      code,
    })
  },

  getStatus() {
    return get<{
      configured: boolean
      hasCustomCredentials: boolean
      hasClientSecret: boolean
      authorized: boolean
    }>('/google-drive/auth/status')
  },

  saveCredentials(clientId: string, clientSecret?: string) {
    return put<{ success: boolean }>('/google-drive/auth/credentials', {
      clientId,
      clientSecret: clientSecret || undefined,
    })
  },

  clearCredentials() {
    return del<{ success: boolean }>('/google-drive/auth/credentials')
  },

  revoke() {
    return post<{ success: boolean }>('/google-drive/auth/revoke')
  },

  getAccessToken() {
    return get<{ access_token: string }>('/google-drive/access-token')
  },
}

// ─── Dropbox API ────────────────────────────────────────────────────────────

export const dropboxApi = {
  initiateAuth() {
    return get<{ auth_url: string; session_token: string }>('/dropbox/auth')
  },

  completeAuth(sessionToken: string, code: string) {
    return post<{ success: boolean }>('/dropbox/auth/callback', {
      session_token: sessionToken,
      code,
    })
  },

  getStatus() {
    return get<{ configured: boolean; hasCustomAppKey: boolean; authorized: boolean }>('/dropbox/auth/status')
  },

  saveCredentials(appKey: string) {
    return put<{ success: boolean }>('/dropbox/auth/credentials', { appKey })
  },

  clearCredentials() {
    return del<{ success: boolean }>('/dropbox/auth/credentials')
  },

  revoke() {
    return post<{ success: boolean }>('/dropbox/auth/revoke')
  },

  getAccessToken() {
    return get<{ access_token: string }>('/dropbox/access-token')
  },
}
