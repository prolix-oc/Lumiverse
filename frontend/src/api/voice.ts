import {
  createProviderRegistryProjection,
  FRONTEND_PROVIDER_SCOPE,
  type ProviderRegistryChangedPayload,
  type ProviderRegistryEntry,
} from '@/ws/provider-registry-projection'

export type VoiceProviderKind = 'tts' | 'stt'
export type VoiceProviderStatus = 'ok' | 'unavailable' | 'timeout'

export interface VoiceProviderOption {
  id: string
  kind: VoiceProviderKind
  name: string
  source: 'registry'
  status: VoiceProviderStatus
}

const voiceListeners = new Set<() => void>()
let voiceProjection = createProviderRegistryProjection({
  authorizedUserId: 'local',
  authorizedScope: FRONTEND_PROVIDER_SCOPE,
})

function voiceEntryDenied(entry: ProviderRegistryEntry): boolean {
  return entry.denied === true || entry.visible === false || entry.status === 'denied'
}

function voiceEntryStatus(entry: ProviderRegistryEntry): VoiceProviderStatus {
  if (entry.status === 'timeout' || entry.availability === 'timeout') return 'timeout'
  if (entry.status === 'unavailable' || entry.availability === 'unavailable') return 'unavailable'
  return 'ok'
}

function notifyVoiceProviders(): void {
  for (const listener of voiceListeners) listener()
}

export function resetVoiceProviderProjection(userId = 'local'): void {
  voiceProjection = createProviderRegistryProjection({
    authorizedUserId: userId,
    authorizedScope: FRONTEND_PROVIDER_SCOPE,
  })
}

export function applyVoiceProviderRegistryEvent(
  event: ProviderRegistryChangedPayload,
): 'applied' | 'queued' | 'ignored' {
  try {
    const result = voiceProjection.applyEvent(event)
    if (result === 'applied') notifyVoiceProviders()
    return result
  } catch {
    return 'ignored'
  }
}

export function subscribeVoiceProviders(listener: () => void): () => void {
  voiceListeners.add(listener)
  return () => { voiceListeners.delete(listener) }
}

export function resolveVoiceProviderVisibility(entry: Pick<ProviderRegistryEntry, 'status' | 'availability'>): VoiceProviderStatus | null {
  if (entry.status === 'timeout' || entry.availability === 'timeout') return 'timeout'
  if (entry.status === 'unavailable' || entry.availability === 'unavailable') return 'unavailable'
  if (entry.status === 'ok' || entry.availability === 'ok') return 'ok'
  return null
}

/** Live spindle-registered TTS/STT engines from the frontend projection. */
export function listVoiceProviders(): { tts: VoiceProviderOption[]; stt: VoiceProviderOption[] } {
  const tts: VoiceProviderOption[] = []
  const stt: VoiceProviderOption[] = []
  for (const entry of voiceProjection.list()) {
    try {
      if (voiceEntryDenied(entry)) continue
      const kind = entry.kind === 'stt' ? 'stt' : entry.kind === 'tts' ? 'tts' : null
      if (!kind) continue
      const option: VoiceProviderOption = {
        id: entry.id,
        kind,
        name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
        source: 'registry',
        status: voiceEntryStatus(entry),
      }
      if (kind === 'tts') tts.push(option)
      else stt.push(option)
    } catch {
      // Isolated: one bad voice descriptor cannot hide the rest of the menu.
    }
  }
  return { tts, stt }
}
