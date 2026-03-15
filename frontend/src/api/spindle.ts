import { get, post, del, put } from './client'
import type { ExtensionInfo, SpindleManifest, ToolRegistration } from 'lumiverse-spindle-types'

export interface EphemeralPoolConfig {
  globalMaxBytes: number
  extensionDefaultMaxBytes: number
  extensionMaxOverrides: Record<string, number>
  reservationTtlMs: number
}

export interface EphemeralPoolGlobal {
  maxBytes: number
  usedBytes: number
  reservedBytes: number
  availableBytes: number
}

export interface EphemeralPoolExtensionRow {
  extensionId: string
  identifier: string
  name: string
  enabled: boolean
  hasEphemeralPermission: boolean
  extensionMaxBytes: number
  usedBytes: number
  reservedBytes: number
  availableBytes: number
  fileCount: number
  reservations?: Array<{
    id: string
    sizeBytes: number
    consumedBytes: number
    remainingBytes: number
    createdAt: string
    expiresAt: string
    reason?: string
  }>
}

export interface EphemeralOverviewAdmin {
  config: EphemeralPoolConfig
  global: EphemeralPoolGlobal
  extensions: EphemeralPoolExtensionRow[]
}

export interface EphemeralOverviewMe {
  role: string
  canEditPools: boolean
  global: EphemeralPoolGlobal
  extensions: EphemeralPoolExtensionRow[]
}

export const spindleApi = {
  list() {
    return get<{ extensions: ExtensionInfo[]; isPrivileged: boolean }>('/spindle')
  },

  install(githubUrl: string) {
    return post<ExtensionInfo>('/spindle/install', { github_url: githubUrl })
  },

  importLocal() {
    return post<{
      imported: ExtensionInfo[]
      skipped: Array<{ identifier?: string; path: string; reason: string }>
    }>('/spindle/import-local')
  },

  update(id: string) {
    return post<ExtensionInfo>(`/spindle/${id}/update`)
  },

  remove(id: string) {
    return del<{ success: boolean }>(`/spindle/${id}`)
  },

  enable(id: string) {
    return post<{ success: boolean }>(`/spindle/${id}/enable`)
  },

  disable(id: string) {
    return post<{ success: boolean }>(`/spindle/${id}/disable`)
  },

  restart(id: string) {
    return post<{ success: boolean }>(`/spindle/${id}/restart`)
  },

  getPermissions(id: string) {
    return get<{ requested: string[]; granted: string[] }>(`/spindle/${id}/permissions`)
  },

  setPermissions(id: string, grants: { grant?: string[]; revoke?: string[] }) {
    return post<{ requested: string[]; granted: string[] }>(`/spindle/${id}/permissions`, grants)
  },

  getManifest(id: string) {
    return get<SpindleManifest>(`/spindle/${id}/manifest`)
  },

  getTools() {
    return get<ToolRegistration[]>('/spindle/tools')
  },

  getEphemeralOverviewAdmin() {
    return get<EphemeralOverviewAdmin>('/spindle/ephemeral/overview')
  },

  getEphemeralOverviewMe() {
    return get<EphemeralOverviewMe>('/spindle/ephemeral/overview/me')
  },

  getEphemeralConfig() {
    return get<EphemeralPoolConfig>('/spindle/ephemeral/config')
  },

  setEphemeralConfig(payload: {
    password: string
    globalMaxBytes?: number
    extensionDefaultMaxBytes?: number
    extensionMaxOverrides?: Record<string, number>
    reservationTtlMs?: number
  }) {
    return put<EphemeralPoolConfig>('/spindle/ephemeral/config', payload)
  },
}
