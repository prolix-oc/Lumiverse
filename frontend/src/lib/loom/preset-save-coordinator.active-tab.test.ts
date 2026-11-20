import { expect, mock, test } from 'bun:test'

const controller = new AbortController()
mock.module('@/lib/active-tab', () => ({ activeTab: {
  signal: controller.signal, assertActive() { controller.signal.throwIfAborted() },
} }))
const { createPresetSaveCoordinator } = await import('./preset-save-coordinator')
const { unmarshalPreset } = await import('./service')

test('a late save completion from a displaced tab cannot remove the new owners recovery draft', async () => {
  let finishWrite!: () => void
  let started!: () => void
  const writing = new Promise<void>(resolve => { started = resolve })
  const row = { id: 'preset', name: 'Original', provider: 'loom',
    parameters: {}, prompt_order: [], prompts: {}, metadata: {}, created_at: 1, updated_at: 1 }
  const coordinator = createPresetSaveCoordinator({ update: async () => {
    controller.signal.throwIfAborted()
    await new Promise<void>(resolve => { finishWrite = resolve; started() })
    return { ...row, name: 'Old draft' }
  } })
  coordinator.setScope('account')
  const base = unmarshalPreset(row)
  coordinator.hydrate(base)
  coordinator.mutate(base.id, base, preset => ({ ...preset, name: 'Old draft' }), { immediate: true })
  const pending = coordinator.flush(base.id)
  await writing
  const reason = new Error('Tab inactive')
  controller.abort(reason)
  const key = '__lumiverse_pending_loom_presets:account'
  const newer = JSON.stringify({ preset: { draft: 'replacement document' } })
  localStorage.setItem(key, newer)
  finishWrite()
  await pending
  expect(localStorage.getItem(key)).toBe(newer)
})
