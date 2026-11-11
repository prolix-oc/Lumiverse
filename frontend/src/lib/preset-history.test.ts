import { expect, test } from 'bun:test'
import type { Message } from '@/types/api'
import { selectedPresetHistorySignature } from './preset-history'

const message = { id: 'reply', content: 'Saved', is_user: false, swipe_id: 0, swipes: ['Saved', 'Other'], extra: {
  generationMetrics: { presetId: 'a', presetName: 'A', tps: 1 },
  spindle_metadata: { preset_contexts: [{ preset_id: 'a' }, { preset_id: 'b' }] },
} } as unknown as Message

test('only selected attribution and visibility change the history signature', () => {
  const signature = selectedPresetHistorySignature(message)
  expect(selectedPresetHistorySignature({ ...message, content: 'Saved plus continuation', extra: {
    ...message.extra, generationMetrics: { ...message.extra.generationMetrics, tps: 99 },
    spindle_metadata: { preset_contexts: [{ preset_id: 'a' }, { preset_id: 'new inactive' }] },
  } })).toBe(signature)
  expect(selectedPresetHistorySignature({ ...message, swipe_id: 1 })).not.toBe(signature)
  expect(selectedPresetHistorySignature({ ...message, extra: { ...message.extra, hidden: true } })).toBe('')
  expect(selectedPresetHistorySignature({ ...message, extra: { ...message.extra,
    generationMetrics: { presetId: 'a', presetName: 'Renamed' } } })).not.toBe(signature)
})
test('canonical selected slots override stale top-level projections, including empty slots', () => {
  const old = { ...message, extra: { ...message.extra, generationMetricsBySwipe: [message.extra.generationMetrics] } }
  const next = { ...old, extra: { ...old.extra, generationMetrics: { presetId: 'a', presetName: 'Late name' } } }
  expect(selectedPresetHistorySignature(next)).toBe(selectedPresetHistorySignature(old))
  expect(selectedPresetHistorySignature({ ...next, swipe_id: 1, extra: { ...next.extra,
    spindle_metadata: { preset_contexts: [] } } })).toBe('')
})
