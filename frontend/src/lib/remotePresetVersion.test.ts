import { expect, test } from 'bun:test'
import { remotePresetVersionLabel } from './remotePresetVersion'

test('distinguishes Illarin releases with missing or repeated display labels', () => {
  expect(remotePresetVersionLabel('illarin', null, 2)).toBe('2')
  expect(remotePresetVersionLabel('illarin', '1.0.0', 2)).toBe('2 (1.0.0)')
  expect(remotePresetVersionLabel('illarin', '1.0.0', 3)).toBe('3 (1.0.0)')
  expect(remotePresetVersionLabel('illarin', 'v2', 2)).toBe('2')
})

test('preserves legacy and LumiHub labels without inventing release numbers', () => {
  expect(remotePresetVersionLabel('illarin', '1.0.0', undefined)).toBe('1.0.0')
  expect(remotePresetVersionLabel('lumihub', '1.0.0', 2)).toBe('1.0.0')
  expect(remotePresetVersionLabel('illarin', '1.0.0', -1)).toBe('1.0.0')
})
