import { afterEach, describe, expect, test } from 'bun:test'
import {
  applySidecarProviderRegistryEvent,
  listSidecarProviders,
  resetSidecarProviderProjection,
  resolveCortexSidecarVisibility,
} from './memory-cortex'
import { FRONTEND_PROVIDER_SCOPE, type ProviderRegistryChangedPayload } from '@/ws/provider-registry-projection'

function event(
  partial: Partial<ProviderRegistryChangedPayload> & Pick<ProviderRegistryChangedPayload, 'action'>,
): ProviderRegistryChangedPayload {
  return {
    userId: 'local',
    scope: FRONTEND_PROVIDER_SCOPE,
    generation: 1,
    revision: 1,
    payload: { id: 'prov-1', kind: 'sidecar' },
    ...partial,
  }
}

afterEach(() => {
  resetSidecarProviderProjection()
})

describe('frontend memory-cortex provider registry', () => {
  test('emits scoped provider_changed add remove and change after registry commit', () => {
    expect(applySidecarProviderRegistryEvent(event({
      action: 'add',
      payload: { id: 'ext-sidecar', kind: 'sidecar', name: 'Ext Sidecar' },
    }))).toBe('applied')
    expect(listSidecarProviders().some((row) => row.id === 'ext-sidecar')).toBe(true)

    expect(applySidecarProviderRegistryEvent(event({
      action: 'change',
      revision: 2,
      payload: { id: 'ext-sidecar', kind: 'sidecar', name: 'Renamed Sidecar' },
    }))).toBe('applied')
    expect(listSidecarProviders().find((row) => row.id === 'ext-sidecar')?.name).toBe('Renamed Sidecar')

    expect(applySidecarProviderRegistryEvent(event({
      action: 'remove',
      revision: 3,
      payload: { id: 'ext-sidecar', kind: 'sidecar' },
    }))).toBe('applied')
    expect(listSidecarProviders().some((row) => row.id === 'ext-sidecar')).toBe(false)
  })

  test('removes embedding TTS STT and sidecar options after unload without page reload', () => {
    applySidecarProviderRegistryEvent(event({
      action: 'add',
      payload: { id: 'live-sidecar', kind: 'sidecar' },
    }))
    expect(listSidecarProviders().some((row) => row.id === 'live-sidecar')).toBe(true)

    applySidecarProviderRegistryEvent(event({
      action: 'remove',
      revision: 2,
      payload: { id: 'live-sidecar', kind: 'sidecar' },
    }))
    expect(listSidecarProviders().some((row) => row.id === 'live-sidecar')).toBe(false)
  })

  test('renders unavailable and timeout fallback', () => {
    applySidecarProviderRegistryEvent(event({
      action: 'add',
      payload: { id: 'down-sidecar', kind: 'sidecar', status: 'unavailable' },
    }))
    applySidecarProviderRegistryEvent(event({
      action: 'add',
      revision: 2,
      payload: { id: 'slow-sidecar', kind: 'sidecar', availability: 'timeout' },
    }))

    expect(listSidecarProviders().find((row) => row.id === 'down-sidecar')?.status).toBe('unavailable')
    expect(listSidecarProviders().find((row) => row.id === 'slow-sidecar')?.status).toBe('timeout')
    expect(resolveCortexSidecarVisibility({
      health: { availability: 'unavailable', ready: false, connectivity: { attempted: false, success: null, message: '' } },
    })).toBe('unavailable')
    expect(resolveCortexSidecarVisibility({
      health: { availability: 'ok', ready: true, connectivity: { attempted: true, success: false, message: 'timeout', timedOut: true } },
    })).toBe('timeout')
  })

  test('denied registration is not visible to consumers', () => {
    applySidecarProviderRegistryEvent(event({
      action: 'add',
      payload: { id: 'denied-sidecar', kind: 'sidecar', denied: true },
    }))
    expect(applySidecarProviderRegistryEvent(event({
      action: 'add',
      revision: 2,
      userId: 'intruder',
      payload: { id: 'foreign-sidecar', kind: 'sidecar' },
    }))).toBe('ignored')

    const ids = listSidecarProviders().map((row) => row.id)
    expect(ids).not.toContain('denied-sidecar')
    expect(ids).not.toContain('foreign-sidecar')
  })

  test('provider failure is isolated', () => {
    applySidecarProviderRegistryEvent(event({
      action: 'add',
      payload: { id: 'good-sidecar', kind: 'sidecar' },
    }))
    const poison = { id: 'broken-sidecar', kind: 'sidecar' } as Record<string, unknown>
    Object.defineProperty(poison, 'name', {
      enumerable: true,
      get() { throw new Error('sidecar boom') },
    })
    applySidecarProviderRegistryEvent(event({
      action: 'add',
      revision: 2,
      payload: poison,
    }))

    const listed = listSidecarProviders()
    expect(listed.some((row) => row.id === 'good-sidecar')).toBe(true)
    expect(listed.some((row) => row.id === 'broken-sidecar')).toBe(false)
  })
})
