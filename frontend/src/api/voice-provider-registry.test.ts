import { afterEach, describe, expect, test } from 'bun:test'
import {
  applyVoiceProviderRegistryEvent,
  listVoiceProviders,
  resetVoiceProviderProjection,
  resolveVoiceProviderVisibility,
} from './voice'
import { FRONTEND_PROVIDER_SCOPE, type ProviderRegistryChangedPayload } from '@/ws/provider-registry-projection'

function event(
  partial: Partial<ProviderRegistryChangedPayload> & Pick<ProviderRegistryChangedPayload, 'action'>,
): ProviderRegistryChangedPayload {
  return {
    userId: 'local',
    scope: FRONTEND_PROVIDER_SCOPE,
    generation: 1,
    revision: 1,
    payload: { id: 'prov-1', kind: 'tts' },
    ...partial,
  }
}

afterEach(() => {
  resetVoiceProviderProjection()
})

describe('frontend voice provider registry', () => {
  test('emits scoped provider_changed add remove and change after registry commit', () => {
    expect(applyVoiceProviderRegistryEvent(event({
      action: 'add',
      payload: { id: 'ext-tts', kind: 'tts', name: 'Ext TTS' },
    }))).toBe('applied')
    expect(applyVoiceProviderRegistryEvent(event({
      action: 'add',
      revision: 2,
      payload: { id: 'ext-stt', kind: 'stt', name: 'Ext STT' },
    }))).toBe('applied')
    expect(listVoiceProviders().tts.some((row) => row.id === 'ext-tts')).toBe(true)
    expect(listVoiceProviders().stt.some((row) => row.id === 'ext-stt')).toBe(true)

    expect(applyVoiceProviderRegistryEvent(event({
      action: 'change',
      revision: 3,
      payload: { id: 'ext-tts', kind: 'tts', name: 'Renamed TTS' },
    }))).toBe('applied')
    expect(listVoiceProviders().tts.find((row) => row.id === 'ext-tts')?.name).toBe('Renamed TTS')

    expect(applyVoiceProviderRegistryEvent(event({
      action: 'remove',
      revision: 4,
      payload: { id: 'ext-tts', kind: 'tts' },
    }))).toBe('applied')
    expect(listVoiceProviders().tts.some((row) => row.id === 'ext-tts')).toBe(false)
    expect(listVoiceProviders().stt.some((row) => row.id === 'ext-stt')).toBe(true)
  })

  test('removes embedding TTS STT and sidecar options after unload without page reload', () => {
    applyVoiceProviderRegistryEvent(event({
      action: 'add',
      payload: { id: 'live-tts', kind: 'tts' },
    }))
    applyVoiceProviderRegistryEvent(event({
      action: 'add',
      revision: 2,
      payload: { id: 'live-stt', kind: 'stt' },
    }))
    expect(listVoiceProviders().tts.some((row) => row.id === 'live-tts')).toBe(true)
    expect(listVoiceProviders().stt.some((row) => row.id === 'live-stt')).toBe(true)

    applyVoiceProviderRegistryEvent(event({
      action: 'remove',
      revision: 3,
      payload: { id: 'live-tts' },
    }))
    applyVoiceProviderRegistryEvent(event({
      action: 'remove',
      revision: 4,
      payload: { id: 'live-stt' },
    }))
    expect(listVoiceProviders().tts.some((row) => row.id === 'live-tts')).toBe(false)
    expect(listVoiceProviders().stt.some((row) => row.id === 'live-stt')).toBe(false)
  })

  test('renders unavailable and timeout fallback', () => {
    applyVoiceProviderRegistryEvent(event({
      action: 'add',
      payload: { id: 'down-tts', kind: 'tts', status: 'unavailable' },
    }))
    applyVoiceProviderRegistryEvent(event({
      action: 'add',
      revision: 2,
      payload: { id: 'slow-stt', kind: 'stt', availability: 'timeout' },
    }))

    expect(listVoiceProviders().tts.find((row) => row.id === 'down-tts')?.status).toBe('unavailable')
    expect(listVoiceProviders().stt.find((row) => row.id === 'slow-stt')?.status).toBe('timeout')
    expect(resolveVoiceProviderVisibility({ status: 'unavailable', availability: undefined })).toBe('unavailable')
    expect(resolveVoiceProviderVisibility({ status: undefined, availability: 'timeout' })).toBe('timeout')
  })

  test('denied registration is not visible to consumers', () => {
    applyVoiceProviderRegistryEvent(event({
      action: 'add',
      payload: { id: 'denied-tts', kind: 'tts', denied: true },
    }))
    expect(applyVoiceProviderRegistryEvent(event({
      action: 'add',
      revision: 2,
      userId: 'intruder',
      payload: { id: 'foreign-stt', kind: 'stt' },
    }))).toBe('ignored')

    expect(listVoiceProviders().tts.some((row) => row.id === 'denied-tts')).toBe(false)
    expect(listVoiceProviders().stt.some((row) => row.id === 'foreign-stt')).toBe(false)
  })

  test('provider failure is isolated', () => {
    applyVoiceProviderRegistryEvent(event({
      action: 'add',
      payload: { id: 'good-tts', kind: 'tts' },
    }))
    const poison = { id: 'broken-tts', kind: 'tts' } as Record<string, unknown>
    Object.defineProperty(poison, 'name', {
      enumerable: true,
      get() { throw new Error('tts boom') },
    })
    applyVoiceProviderRegistryEvent(event({
      action: 'add',
      revision: 2,
      payload: poison,
    }))

    const listed = listVoiceProviders()
    expect(listed.tts.some((row) => row.id === 'good-tts')).toBe(true)
    expect(listed.tts.some((row) => row.id === 'broken-tts')).toBe(false)
  })
})
