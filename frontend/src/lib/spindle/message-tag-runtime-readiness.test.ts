import { afterEach, describe, expect, test } from 'bun:test'
import type { ExtensionInfo } from 'lumiverse-spindle-types'
import {
  applyMessageTagRuntimeCapabilityChange,
  areMessageTagRuntimeInterceptorsReady,
  clearAttachedMessageTagInterceptors,
  getMessageTagRuntimeReadinessDiagnostics,
  noteMessageTagInterceptorAttached,
  noteMessageTagInterceptorDetached,
  reconcileMessageTagRuntimeCapabilities,
  resetMessageTagRuntimeReadinessForTests,
} from './message-tag-runtime-readiness'

function extension(
  id: string,
  capabilities: string[] = [],
): ExtensionInfo {
  return {
    id,
    enabled: true,
    has_frontend: true,
    frontend_runtime_capabilities: capabilities,
  } as unknown as ExtensionInfo
}

afterEach(() => {
  resetMessageTagRuntimeReadinessForTests()
})

describe('message tag runtime readiness', () => {
  test('blocks until the runtime capability snapshot arrives', () => {
    expect(areMessageTagRuntimeInterceptorsReady()).toBe(false)
    reconcileMessageTagRuntimeCapabilities([])
    expect(areMessageTagRuntimeInterceptorsReady()).toBe(true)
  })

  test('waits for each declared extension to attach an interceptor', () => {
    reconcileMessageTagRuntimeCapabilities([
      extension('tracker', ['message_tag_interceptor']),
      extension('ordinary'),
    ])
    expect(areMessageTagRuntimeInterceptorsReady()).toBe(false)

    expect(getMessageTagRuntimeReadinessDiagnostics()).toMatchObject({
      ready: false,
      snapshotReady: true,
      declaredExtensions: [{ extensionId: 'tracker', attachedCount: 0 }],
      missingExtensionIds: ['tracker'],
    })

    noteMessageTagInterceptorAttached('tracker')
    expect(areMessageTagRuntimeInterceptorsReady()).toBe(true)
    expect(getMessageTagRuntimeReadinessDiagnostics()).toMatchObject({
      ready: true,
      attachedInterceptors: [{ extensionId: 'tracker', count: 1 }],
      missingExtensionIds: [],
    })

    noteMessageTagInterceptorDetached('tracker')
    expect(areMessageTagRuntimeInterceptorsReady()).toBe(false)
  })

  test('preserves live declarations received before the list snapshot', () => {
    applyMessageTagRuntimeCapabilityChange({
      action: 'registered',
      extensionId: 'tracker',
      capability: 'message_tag_interceptor',
    })
    reconcileMessageTagRuntimeCapabilities([extension('tracker')])
    expect(areMessageTagRuntimeInterceptorsReady()).toBe(false)

    noteMessageTagInterceptorAttached('tracker')
    expect(areMessageTagRuntimeInterceptorsReady()).toBe(true)

    clearAttachedMessageTagInterceptors('tracker')
    applyMessageTagRuntimeCapabilityChange({
      action: 'unregistered',
      extensionId: 'tracker',
      capability: 'message_tag_interceptor',
    })
    expect(areMessageTagRuntimeInterceptorsReady()).toBe(true)
  })

  test('ignores live declarations for extensions hidden from the viewer', () => {
    reconcileMessageTagRuntimeCapabilities([])
    applyMessageTagRuntimeCapabilityChange({
      action: 'registered',
      extensionId: 'other-users-extension',
      capability: 'message_tag_interceptor',
    }, { visible: false })
    expect(areMessageTagRuntimeInterceptorsReady()).toBe(true)
  })
})
