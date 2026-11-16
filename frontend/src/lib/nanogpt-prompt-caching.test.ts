import { expect, test } from 'bun:test'
import { buildNanoGptCachingMetadata, parseNanoGptCachingSettings } from './nanogpt-prompt-caching'

test('connection edits preserve automatic cutoff settings and canonicalize aliases', () => {
  for (const advanced of [
    { autoCut: false, tailReserveMessages: 12 },
    { auto_cut: false, tail_reserve_messages: 12 },
  ]) {
    const settings = parseNanoGptCachingSettings({ enabled: true, ...advanced })
    expect(buildNanoGptCachingMetadata(settings)).toMatchObject({ autoCut: false, tailReserveMessages: 12 })
    const disabled = parseNanoGptCachingSettings({ enabled: false, ...advanced })
    expect(buildNanoGptCachingMetadata({ ...disabled, enabled: true })).toMatchObject({ autoCut: false, tailReserveMessages: 12 })
  }
})

test('a zero reserve survives round trips and invalid settings use the defaults', () => {
  expect(buildNanoGptCachingMetadata(parseNanoGptCachingSettings({ enabled: true, tailReserveMessages: 0 })))
    .toMatchObject({ tailReserveMessages: 0 })
  for (const value of [-1, 1.5, '12', NaN, Infinity, null]) {
    const settings = parseNanoGptCachingSettings({ enabled: true, tailReserveMessages: value, autoCut: value })
    expect(settings.tailReserveMessages).toBeUndefined()
    expect(settings.autoCut).toBeUndefined()
  }
})
