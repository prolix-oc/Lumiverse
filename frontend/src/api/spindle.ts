import { get, post, del, put } from './client'
import type { ExtensionInfo, SpindleManifest, ToolRegistration } from 'lumiverse-spindle-types'

const manifestCache = new Map<string, SpindleManifest>()
const manifestInFlight = new Map<string, Promise<SpindleManifest>>()

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

  install(githubUrl: string, branch?: string | null) {
    return post<ExtensionInfo>('/spindle/install', { github_url: githubUrl, branch: branch || undefined })
  },

  listRemoteBranches(githubUrl: string) {
    return post<{ branches: string[] }>('/spindle/branches', { github_url: githubUrl })
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

  updateAll() {
    return post<{ started: boolean; total: number }>('/spindle/update-all')
  },

  getBranches(id: string) {
    return get<{ current: string | null; branches: string[] }>(`/spindle/${id}/branches`)
  },

  switchBranch(id: string, branch: string) {
    return post<ExtensionInfo>(`/spindle/${id}/switch-branch`, { branch })
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

  getManifest(id: string, options?: { force?: boolean }) {
    if (!options?.force) {
      const cached = manifestCache.get(id)
      if (cached) return Promise.resolve(cached)

      const pending = manifestInFlight.get(id)
      if (pending) return pending
    }

    const request = get<SpindleManifest>(`/spindle/${id}/manifest`)
      .then((manifest) => {
        manifestCache.set(id, manifest)
        return manifest
      })
      .finally(() => {
        if (manifestInFlight.get(id) === request) {
          manifestInFlight.delete(id)
        }
      })

    manifestInFlight.set(id, request)
    return request
  },

  clearManifestCache(id?: string) {
    if (id) {
      manifestCache.delete(id)
      manifestInFlight.delete(id)
      return
    }
    manifestCache.clear()
    manifestInFlight.clear()
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
