import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import type { PendingConfirmRequest, SystemAudioSessionInfo } from '@/types/store'
import { registerSystemAudioSource } from './system-audio-source'
import type { SystemAudioSourceHandlers } from './system-audio-source'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
Object.assign(globalThis, { window: dom.window, CustomEvent: dom.window.CustomEvent })
const ownerListeners = new Set<(next: typeof state) => void>()
const prompts: PendingConfirmRequest[] = []
const state = {
  user: { id: 'alice' } as { id: string } | null,
  pendingConfirm: null as PendingConfirmRequest | null,
  systemAudioSessions: [] as SystemAudioSessionInfo[],
  openSpindleConfirm(request: PendingConfirmRequest) { state.pendingConfirm = request; prompts.push(request) },
  addSystemAudioSession(session: SystemAudioSessionInfo) { state.systemAudioSessions.push(session) },
  removeSystemAudioSession(id: string) { state.systemAudioSessions = state.systemAudioSessions.filter(session => session.id !== id) },
}
mock.module('@/store', () => ({ useStore: {
  getState: () => state,
  setState: (patch: Partial<typeof state>) => { Object.assign(state, patch); for (const listener of [...ownerListeners]) listener(state) },
  subscribe: (listener: (next: typeof state) => void) => { ownerListeners.add(listener); return () => { ownerListeners.delete(listener) } },
} }))
mock.module('@/i18n', () => ({ default: { t: (key: string) => key } }))
const { createNativeSystemAudioAPI } = await import('./system-audio-native')
const { systemAudioConsent } = await import('./system-audio-consent')
let nextId = 0
let unregister: (() => void) | undefined
const cleanup: Array<() => void> = []

beforeEach(() => {
  state.user = { id: 'alice' }
  state.pendingConfirm = null
  state.systemAudioSessions = []
  prompts.length = 0
})
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
  unregister?.()
  expect(ownerListeners.size).toBe(0)
})

function setup(id = `audio-install-${++nextId}`) {
  let granted = true
  let enabled = true
  let starts = 0
  let stops = 0
  const teardowns = new Set<() => void>()
  let sourceHandlers: SystemAudioSourceHandlers | undefined
  unregister?.()
  unregister = registerSystemAudioSource({
    availability: () => enabled ? { available: true } : { available: false, reason: 'disabled' },
    async start(handlers) { sourceHandlers = handlers; starts++; return { stop() { stops++ } } },
  })
  const host = createNativeSystemAudioAPI({
    extensionId: id, extensionName: 'Visualizer',
    assertActive() {},
    requirePermission() { if (!granted) throw new Error('PERMISSION_DENIED:system_audio') },
    onTeardown(handler) { teardowns.add(handler); return () => { teardowns.delete(handler) } },
  })
  cleanup.push(() => host.dispose())
  return {
    id, host,
    get starts() { return starts }, get stops() { return stops },
    denyPermission() { granted = false },
    disableHost() { enabled = false },
    teardown() { for (const handler of teardowns) handler() },
    frame() { sourceHandlers?.onFrame({ amplitude: 1, peak: 1, frequencies: [1] }) },
  }
}

function answer(confirmed: boolean, checkboxChecked = false) {
  const request = state.pendingConfirm!
  state.pendingConfirm = null
  window.dispatchEvent(new CustomEvent('spindle:confirm-resolved', { detail: { requestId: request.requestId, confirmed, checkboxChecked } }))
}

test('one-time approval continues to ask on each start; declined remembered approval saves nothing', async () => {
  const t = setup()
  const declined = t.host.api.start({ onFrame() {} })
  answer(false, true)
  await expect(declined.ready).rejects.toMatchObject({ name: 'NotAllowedError' })
  expect(systemAudioConsent.read('alice', t.id).remembered).toBe(false)
  const first = t.host.api.start({ onFrame() {} })
  expect(prompts.at(-1)?.checkboxLabel).toBe('shared:spindle.systemAudio.remember')
  answer(true)
  await first.ready
  first.stop()
  const second = t.host.api.start({ onFrame() {} })
  expect(prompts).toHaveLength(3)
  answer(true)
  await second.ready
})

test('explicit remembered approval skips subsequent prompts and still shows the capture indicator', async () => {
  const t = setup()
  const first = t.host.api.start({ onFrame() {} })
  answer(true, true)
  await first.ready
  first.stop()
  await t.host.api.start({ onFrame() {} }).ready
  expect(prompts).toHaveLength(1)
  expect(state.systemAudioSessions).toHaveLength(1)
  expect(t.starts).toBe(2)
})

test('Stop blocks automatic restarts, including after extension reload, until the user allows requests again', async () => {
  const t = setup()
  const ended: string[] = []
  let restarted: Promise<void> | undefined
  const first = t.host.api.start({ onFrame() {}, onEnd: reason => {
    ended.push(reason)
    restarted = t.host.api.start({ onFrame() {} }).ready
  } })
  answer(true, true)
  await first.ready
  state.systemAudioSessions[0].stop()
  expect(ended).toEqual(['user-stopped'])
  expect(t.stops).toBe(1)
  await expect(restarted!).rejects.toMatchObject({ name: 'NotAllowedError' })
  expect(prompts).toHaveLength(1)
  expect(t.starts).toBe(1)
  t.host.dispose()
  const reloaded = setup(t.id)
  await expect(reloaded.host.api.start({ onFrame() {} }).ready).rejects.toMatchObject({ name: 'NotAllowedError' })
  systemAudioConsent.resume('alice', t.id)
  await reloaded.host.api.start({ onFrame() {} }).ready
  expect(reloaded.starts).toBe(1)
  expect(prompts).toHaveLength(1)
})

test('revoking remembered consent stops capture immediately and resume requires fresh approval', async () => {
  const t = setup()
  const ended: string[] = []
  const first = t.host.api.start({ onFrame() {}, onEnd: reason => ended.push(reason) })
  answer(true, true)
  await first.ready
  systemAudioConsent.revoke('alice', t.id)
  expect(ended).toEqual(['revoked'])
  expect(t.stops).toBe(1)
  expect(state.systemAudioSessions).toHaveLength(0)
  await expect(t.host.api.start({ onFrame() {} }).ready).rejects.toMatchObject({ name: 'NotAllowedError' })
  systemAudioConsent.resume('alice', t.id)
  const fresh = t.host.api.start({ onFrame() {} })
  expect(prompts).toHaveLength(2)
  answer(true)
  await fresh.ready
})

test('permission revocation clears a remembered grant and continues to reject capture', async () => {
  const t = setup()
  const first = t.host.api.start({ onFrame() {} })
  answer(true, true)
  await first.ready
  t.denyPermission()
  t.host.revoke()
  expect(t.stops).toBe(1)
  expect(systemAudioConsent.read('alice', t.id).remembered).toBe(false)
  expect(() => t.host.api.start({ onFrame() {} })).toThrow('PERMISSION_DENIED:system_audio')
})

test('remembered consent cannot start capture while the desktop source is disabled', async () => {
  const t = setup()
  const first = t.host.api.start({ onFrame() {} })
  answer(true, true)
  await first.ready
  first.stop()
  t.disableHost()
  await expect(t.host.api.start({ onFrame() {} }).ready).rejects.toMatchObject({ name: 'NotSupportedError' })
  expect(t.starts).toBe(1)
  expect(prompts).toHaveLength(1)
})

test('an approval arriving after permission revocation cannot save consent or open the device', async () => {
  const t = setup()
  const pending = t.host.api.start({ onFrame() {} })
  t.denyPermission()
  answer(true, true)
  await expect(pending.ready).rejects.toMatchObject({ name: 'NotAllowedError' })
  expect(t.starts).toBe(0)
  expect(systemAudioConsent.read('alice', t.id).remembered).toBe(false)
})

test('changing accounts cancels pending consent, ignores a late answer, and cannot reuse approval', async () => {
  const t = setup()
  const pending = t.host.api.start({ onFrame() {} })
  const requestId = state.pendingConfirm!.requestId
  state.user = { id: 'bob' }
  for (const listener of [...ownerListeners]) listener(state)
  await expect(pending.ready).rejects.toMatchObject({ name: 'AbortError' })
  expect(state.pendingConfirm).toBeNull()
  window.dispatchEvent(new CustomEvent('spindle:confirm-resolved', { detail: { requestId, confirmed: true, checkboxChecked: true } }))
  expect(t.starts).toBe(0)
  expect(systemAudioConsent.read('alice', t.id).remembered).toBe(false)
  expect(systemAudioConsent.read('bob', t.id).remembered).toBe(false)
  expect(() => t.host.api.start({ onFrame() {} })).toThrow('SPINDLE_FRONTEND_INACTIVE')
})

test('changing accounts stops a running session and teardown preserves consent without retaining listeners', async () => {
  const t = setup()
  const session = t.host.api.start({ onFrame() {} })
  answer(true, true)
  await session.ready
  state.user = { id: 'bob' }
  for (const listener of [...ownerListeners]) listener(state)
  expect(t.stops).toBe(1)
  expect(state.systemAudioSessions).toHaveLength(0)
  expect(systemAudioConsent.read('alice', t.id).remembered).toBe(true)
  expect(systemAudioConsent.read('bob', t.id).remembered).toBe(false)
  expect(ownerListeners.size).toBe(0)
  t.teardown()
})
