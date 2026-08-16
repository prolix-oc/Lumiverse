/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from 'bun:test'
import { EventType } from '../../../src/ws/events'
import {
  emitProviderRegistryChanged,
  eventBus,
} from '../../../src/ws/bus'
import {
  createProviderRegistryProjection,
  FRONTEND_PROVIDER_SCOPE,
  type ProviderRegistryChangedPayload,
} from './provider-registry-projection'

type EmitCall = {
  event: unknown
  payload: ProviderRegistryChangedPayload
  userId?: string
  options?: { topic?: string }
}

const originalEmit = eventBus.emit.bind(eventBus)
let emitCalls: EmitCall[] = []

function installEmitSpy() {
  emitCalls = []
  eventBus.emit = ((event, payload, userId, options) => {
    emitCalls.push({ event, payload, userId, options })
  }) as typeof eventBus.emit
}

afterEach(() => {
  eventBus.emit = originalEmit
  emitCalls = []
})

function changedEvent(
  partial: Partial<ProviderRegistryChangedPayload> & Pick<ProviderRegistryChangedPayload, 'action'>,
): ProviderRegistryChangedPayload {
  return {
    userId: 'user-a',
    scope: FRONTEND_PROVIDER_SCOPE,
    generation: 1,
    revision: 1,
    payload: { id: 'prov-1' },
    ...partial,
  }
}

describe('useWebSocket provider registry projection', () => {
  test('emits scoped provider_changed add remove and change after registry commit', () => {
    installEmitSpy()

    const actions = ['add', 'remove', 'change'] as const
    for (const [index, action] of actions.entries()) {
      emitProviderRegistryChanged({
        userId: 'user-a',
        scope: FRONTEND_PROVIDER_SCOPE,
        action,
        generation: 4,
        revision: index + 1,
        payload: { id: 'prov-1', name: 'committed' },
      })
    }

    expect(emitCalls).toHaveLength(3)
    expect(emitCalls.map((call) => call.payload.action)).toEqual(['add', 'remove', 'change'])
    for (const call of emitCalls) {
      expect(call.event).toBe(EventType.SPINDLE_PROVIDER_CHANGED)
      expect(call.userId).toBe('user-a')
      expect(call.options?.topic).toBe('user:user-a')
      expect(call.options?.topic).not.toBe('system')
      expect(call.payload.userId).toBe('user-a')
      expect(call.payload.scope).toBe(FRONTEND_PROVIDER_SCOPE)
      expect(call.payload.generation).toBe(4)
    }

    emitCalls = []
    emitProviderRegistryChanged({
      userId: '',
      scope: FRONTEND_PROVIDER_SCOPE,
      action: 'add',
      generation: 4,
      revision: 4,
      payload: { id: 'should-not-broadcast' },
    })
    expect(emitCalls).toEqual([])
  })

  test('projects provider_changed only into the authorized frontend scope', () => {
    const authorized = createProviderRegistryProjection({
      authorizedUserId: 'user-a',
      authorizedScope: FRONTEND_PROVIDER_SCOPE,
    })
    const otherUser = createProviderRegistryProjection({
      authorizedUserId: 'user-b',
      authorizedScope: FRONTEND_PROVIDER_SCOPE,
    })

    const addA = changedEvent({ action: 'add', payload: { id: 'prov-1', name: 'alpha' } })
    expect(authorized.applyEvent(addA)).toBe('applied')
    expect(otherUser.applyEvent(addA)).toBe('ignored')
    expect(authorized.list()).toEqual([{ id: 'prov-1', name: 'alpha' }])
    expect(otherUser.list()).toEqual([])

    expect(authorized.applyEvent(changedEvent({
      action: 'add',
      revision: 2,
      scope: 'worker',
      payload: { id: 'prov-worker' },
    }))).toBe('ignored')

    expect(authorized.applyEvent(changedEvent({
      action: 'change',
      revision: 3,
      payload: { id: 'prov-1', name: 'alpha-updated' },
    }))).toBe('applied')
    expect(authorized.applyEvent(changedEvent({
      action: 'remove',
      revision: 4,
      payload: { id: 'prov-1' },
    }))).toBe('applied')

    expect(authorized.list()).toEqual([])
    expect(otherUser.list()).toEqual([])
  })

  test('suppresses stale generation provider_changed events', () => {
    const projection = createProviderRegistryProjection({
      authorizedUserId: 'user-a',
      authorizedScope: FRONTEND_PROVIDER_SCOPE,
    })

    expect(projection.applyEvent(changedEvent({
      action: 'add',
      generation: 3,
      revision: 1,
      payload: { id: 'fresh', name: 'kept' },
    }))).toBe('applied')

    expect(projection.applyEvent(changedEvent({
      action: 'add',
      generation: 2,
      revision: 99,
      payload: { id: 'stale-gen', name: 'dropped' },
    }))).toBe('ignored')

    expect(projection.applyEvent(changedEvent({
      action: 'change',
      generation: 3,
      revision: 1,
      payload: { id: 'fresh', name: 'same-revision' },
    }))).toBe('ignored')

    expect(projection.applyEvent(changedEvent({
      action: 'change',
      generation: 3,
      revision: 2,
      payload: { id: 'fresh', name: 'newer' },
    }))).toBe('applied')

    expect(projection.list()).toEqual([{ id: 'fresh', name: 'newer' }])
    expect(projection.getGeneration()).toBe(3)
    expect(projection.getRevision()).toBe(2)
  })

  test('resyncs provider projection before applying reconnect events', () => {
    const projection = createProviderRegistryProjection({
      authorizedUserId: 'user-a',
      authorizedScope: FRONTEND_PROVIDER_SCOPE,
    })

    projection.beginReconnectResync()
    expect(projection.isAwaitingResync()).toBe(true)

    expect(projection.applyEvent(changedEvent({
      action: 'add',
      generation: 5,
      revision: 2,
      payload: { id: 'late', name: 'after-snapshot' },
    }))).toBe('queued')
    expect(projection.list()).toEqual([])

    expect(projection.applyEvent(changedEvent({
      action: 'snapshot',
      generation: 5,
      revision: 1,
      payload: { providers: [{ id: 'base', name: 'snapshot' }] },
    }))).toBe('applied')

    expect(projection.isAwaitingResync()).toBe(false)
    expect(projection.list()).toEqual([
      { id: 'base', name: 'snapshot' },
      { id: 'late', name: 'after-snapshot' },
    ])
    expect(projection.getGeneration()).toBe(5)
    expect(projection.getRevision()).toBe(2)
  })
})
