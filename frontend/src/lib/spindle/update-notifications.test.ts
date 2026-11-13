import { describe, expect, test } from 'bun:test'
import type { ExtensionUpdateInfo } from '@/types/spindle-updates'
import {
  extensionUpdateFingerprint,
  pruneAnnouncedExtensionUpdates,
  selectToastableExtensionUpdates,
} from './update-notifications'

function update(
  extensionId: string,
  identifier: string,
  remoteCommit: string,
): ExtensionUpdateInfo {
  return {
    extensionId,
    identifier,
    name: identifier,
    currentVersion: '1.0.0',
    branch: 'main',
    localCommit: 'local',
    remoteCommit,
  }
}

describe('extension update notification selection', () => {
  test('keeps badge-only extensions out of toast batches', () => {
    const updates = [
      update('one', 'canvas', 'remote-one'),
      update('two', 'chronicle', 'remote-two'),
    ]

    expect(
      selectToastableExtensionUpdates(
        updates,
        { chronicle: true },
        new Set(),
      ).map((item) => item.identifier),
    ).toEqual(['canvas'])
  })

  test('announces each remote commit once while it remains active', () => {
    const first = update('one', 'canvas', 'remote-one')
    const announced = new Set([extensionUpdateFingerprint(first)])

    expect(selectToastableExtensionUpdates([first], {}, announced)).toEqual([])
    expect(pruneAnnouncedExtensionUpdates(announced, [first])).toEqual(announced)

    const next = update('one', 'canvas', 'remote-two')
    const pruned = pruneAnnouncedExtensionUpdates(announced, [next])
    expect(pruned.size).toBe(0)
    expect(selectToastableExtensionUpdates([next], {}, pruned)).toEqual([next])
  })
})
