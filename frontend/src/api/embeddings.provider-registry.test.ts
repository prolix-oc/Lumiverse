import { afterEach, describe, expect, test } from 'bun:test'
import {
  applyEmbeddingProviderRegistryEvent,
  listEmbeddingDrivers,
  resetEmbeddingProviderProjection,
  resolveEmbeddingProviderVisibility,
} from './embeddings'
import { FRONTEND_PROVIDER_SCOPE, type ProviderRegistryChangedPayload } from '@/ws/provider-registry-projection'

function event(
  partial: Partial<ProviderRegistryChangedPayload> & Pick<ProviderRegistryChangedPayload, 'action'>,
): ProviderRegistryChangedPayload {
  return {
    userId: 'local',
    scope: FRONTEND_PROVIDER_SCOPE,
    generation: 1,
    revision: 1,
    payload: { id: 'prov-1', kind: 'embedding' },
    ...partial,
  }
}

afterEach(() => {
  resetEmbeddingProviderProjection()
})

describe('frontend embeddings provider registry', () => {
  test('emits scoped provider_changed add remove and change after registry commit', () => {
    expect(applyEmbeddingProviderRegistryEvent(event({
      action: 'add',
      payload: { id: 'ext-embed', kind: 'embedding', name: 'Ext Embed' },
    }))).toBe('applied')
    expect(listEmbeddingDrivers().some((row) => row.id === 'ext-embed')).toBe(true)

    expect(applyEmbeddingProviderRegistryEvent(event({
      action: 'change',
      revision: 2,
      payload: { id: 'ext-embed', kind: 'embedding', name: 'Renamed' },
    }))).toBe('applied')
    expect(listEmbeddingDrivers().find((row) => row.id === 'ext-embed')?.name).toBe('Renamed')

    expect(applyEmbeddingProviderRegistryEvent(event({
      action: 'remove',
      revision: 3,
      payload: { id: 'ext-embed', kind: 'embedding' },
    }))).toBe('applied')
    expect(listEmbeddingDrivers().some((row) => row.id === 'ext-embed')).toBe(false)
  })

  test('removes embedding TTS STT and sidecar options after unload without page reload', () => {
    applyEmbeddingProviderRegistryEvent(event({
      action: 'add',
      payload: { id: 'live-embed', kind: 'embedding' },
    }))
    expect(listEmbeddingDrivers().some((row) => row.id === 'live-embed')).toBe(true)

    applyEmbeddingProviderRegistryEvent(event({
      action: 'remove',
      revision: 2,
      payload: { id: 'live-embed', kind: 'embedding' },
    }))
    expect(listEmbeddingDrivers().some((row) => row.id === 'live-embed')).toBe(false)
  })

  test('renders unavailable and timeout fallback', () => {
    applyEmbeddingProviderRegistryEvent(event({
      action: 'add',
      payload: { id: 'down-embed', kind: 'embedding', status: 'unavailable' },
    }))
    applyEmbeddingProviderRegistryEvent(event({
      action: 'add',
      revision: 2,
      payload: { id: 'slow-embed', kind: 'embedding', availability: 'timeout' },
    }))

    expect(listEmbeddingDrivers().find((row) => row.id === 'down-embed')?.status).toBe('unavailable')
    expect(listEmbeddingDrivers().find((row) => row.id === 'slow-embed')?.status).toBe('timeout')
    expect(resolveEmbeddingProviderVisibility({ status: 'unavailable', availability: undefined })).toBe('unavailable')
    expect(resolveEmbeddingProviderVisibility({ status: undefined, availability: 'timeout' })).toBe('timeout')
  })

  test('denied registration is not visible to consumers', () => {
    applyEmbeddingProviderRegistryEvent(event({
      action: 'add',
      payload: { id: 'denied-embed', kind: 'embedding', denied: true },
    }))
    expect(applyEmbeddingProviderRegistryEvent(event({
      action: 'add',
      revision: 2,
      userId: 'intruder',
      payload: { id: 'foreign-embed', kind: 'embedding' },
    }))).toBe('ignored')

    const ids = listEmbeddingDrivers().map((row) => row.id)
    expect(ids).not.toContain('denied-embed')
    expect(ids).not.toContain('foreign-embed')
  })

  test('provider failure is isolated', () => {
    applyEmbeddingProviderRegistryEvent(event({
      action: 'add',
      payload: { id: 'good-embed', kind: 'embedding' },
    }))
    const poison = {
      id: 'broken-embed',
      kind: 'embedding',
    } as Record<string, unknown>
    Object.defineProperty(poison, 'name', {
      enumerable: true,
      get() { throw new Error('embed boom') },
    })
    applyEmbeddingProviderRegistryEvent(event({
      action: 'add',
      revision: 2,
      payload: poison,
    }))

    const listed = listEmbeddingDrivers()
    expect(listed.some((row) => row.id === 'good-embed')).toBe(true)
    expect(listed.some((row) => row.id === 'openai-compatible')).toBe(true)
    expect(listed.some((row) => row.id === 'broken-embed')).toBe(false)
  })
})
