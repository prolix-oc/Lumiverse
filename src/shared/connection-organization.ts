import { SPINDLE_CONNECTION_ORGANIZATION_HOST_CAPABILITIES } from 'lumiverse-spindle-types'
import type { SpindleConnectionProfileKind, SpindleConnectionProfileSummary,
  SpindleConnectionOrganizationErrorCode, SpindleConnectionOrganizationError,
  SpindleConnectionOrganizationSnapshot, SpindleConnectionOrganizationOptions,
  SpindleConnectionOrganizationAPI } from 'lumiverse-spindle-types'
import { connectionFolderId, normalizeConnectionLibrary } from './connection-library'
import { recentConnectionIds } from './connection-recents'

export type ConnectionOrganizationKind = SpindleConnectionProfileKind
export type ConnectionOrganizationErrorCode = SpindleConnectionOrganizationErrorCode
export type ConnectionOrganizationError = SpindleConnectionOrganizationError
export function organizationError(error: unknown): Error & { code: ConnectionOrganizationErrorCode } {
  const value = error as { code?: string; message?: string; body?: { code?: string } } | undefined
  const candidate = value?.code ?? value?.body?.code ?? value?.message
  const code = (['CONNECTION_KIND_INVALID', 'USER_CONTEXT_REQUIRED', 'CONNECTION_WATCH_LIMIT'].includes(candidate ?? '')
    ? candidate : 'CONNECTION_ORGANIZATION_READ_FAILED') as ConnectionOrganizationErrorCode
  return Object.assign(new Error(code), { code })
}
export type ConnectionOrganizationSnapshot = SpindleConnectionOrganizationSnapshot
export type ConnectionOrganizationOptions = SpindleConnectionOrganizationOptions
export type ConnectionOrganizationAPI = SpindleConnectionOrganizationAPI
export const CONNECTION_ORGANIZATION_CAPABILITIES = SPINDLE_CONNECTION_ORGANIZATION_HOST_CAPABILITIES
export function assertOrganizationKind(kind: unknown): asserts kind is ConnectionOrganizationKind {
  if (!['llm', 'image', 'tts', 'stt', 'embedding', 'decision'].includes(kind as string)) {
    throw Object.assign(new Error('Invalid connection kind'), { code: 'CONNECTION_KIND_INVALID' })
  }
}
export function libraryKind(kind: ConnectionOrganizationKind) { return kind === 'image' ? 'imageGen' : kind }

export function organizationInvalidated(kind: ConnectionOrganizationKind, event: string, payload: unknown): boolean {
  const value = payload as { key?: unknown; keys?: unknown; kind?: unknown } | undefined
  if (event === 'SETTINGS_UPDATED') {
    const keys = typeof value?.key === 'string' ? [value.key] : Array.isArray(value?.keys) ? value.keys : null
    const relevant = ['connectionLibraries', 'connectionsOrder', 'recentConnections', 'connectionsPickerSettings',
      kind === 'llm' ? 'activeProfileId' : kind === 'image' ? 'imageGeneration' : kind === 'embedding' ? 'embeddingConfig' : 'voiceSettings']
    return keys === null || keys.some(key => relevant.includes(key))
  }
  if (event === 'CONNECTION_ORGANIZATION_CHANGED') return value?.kind === kind
  const profileEvents: Record<string, ConnectionOrganizationKind> = { CONNECTION_PROFILE_LOADED: 'llm',
    IMAGE_GEN_CONNECTION_CHANGED: 'image', TTS_CONNECTION_CHANGED: 'tts', STT_CONNECTION_CHANGED: 'stt', DECISION_CONNECTION_CHANGED: 'decision' }
  return event === '__ws_open' || event === 'USER_IMPORT_COMPLETE' || profileEvents[event] === kind
}

/** The single projection used by native and extension readers; never spreads profile data. */
export function projectConnectionOrganization(kind: ConnectionOrganizationKind,
  profiles: SpindleConnectionProfileSummary[], settings: Record<string, any>): Omit<ConnectionOrganizationSnapshot, 'revision'> {
  const key = libraryKind(kind)
  const library = normalizeConnectionLibrary(settings.connectionLibraries?.[key])
  const order: unknown = kind === 'embedding' ? library.profileOrder : settings.connectionsOrder?.[key]
  const byId = new Map(profiles.map(profile => [profile.id, profile]))
  const orderedIds = [...new Set([...(Array.isArray(order) ? order.filter(id => typeof id === 'string') : []), ...byId.keys()])]
    .filter(id => byId.has(id))
  const connections = orderedIds.map(id => {
    const p = byId.get(id)!
    return { id: p.id, kind, name: p.name, provider: p.provider, model: p.model, active: p.active,
      ...(kind === 'tts' && typeof p.voice === 'string' ? { voice: p.voice } : {}) }
  })
  return {
    kind, connections,
    folders: library.folderOrder.map(id => ({ id: id || null,
      name: library.folders.find(folder => folder.id === id)?.name ?? null,
      connectionIds: orderedIds.filter(connectionId => connectionFolderId(library, connectionId) === id),
    })),
    recentConnectionIds: recentConnectionIds(settings.recentConnections, key, settings.connectionsPickerSettings?.recentProfileIds)
      .filter(id => byId.has(id)),
  }
}

/** Subscribe before reading; coalesce invalidations and never deliver an obsolete in-flight read. */
export function watchConnectionOrganization(
  read: () => Promise<ConnectionOrganizationSnapshot>, subscribe: (refresh: () => void) => () => void,
  handler: (snapshot: ConnectionOrganizationSnapshot) => void, onError: (error: Error) => void = () => {},
): () => void {
  let disposed = false, running = false, dirty = false
  let revision: string | undefined
  const report = (error: unknown) => { try { onError(error instanceof Error ? error : new Error('Connection organization watch failed')) } catch { /* Consumer error isolation. */ } }
  const refresh = () => {
    dirty = true
    if (running || disposed) return
    running = true
    void (async () => {
      try {
        while (dirty && !disposed) {
          dirty = false
          try {
            const snapshot = await read()
            if (disposed || dirty || snapshot.revision === revision) continue
            revision = snapshot.revision
            try { handler(snapshot) } catch (error) { report(error) }
          } catch (error) { if (!disposed) report(error) }
        }
      } finally { running = false }
    })()
  }
  const unsubscribe = subscribe(refresh)
  refresh()
  return () => { if (!disposed) { disposed = true; unsubscribe() } }
}
