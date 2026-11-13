import { expect, test } from 'bun:test'
import {
  clearExtensionMountPoints, getExtensionMountPointsVersion, hasExtensionMountPoint,
  recordExtensionMountPoint, subscribeExtensionMountPoints,
} from './extension-mount-points'

test('mount-point observers see deduplicated changes and extension-scoped teardown', () => {
  const version = getExtensionMountPointsVersion()
  const snapshots: number[] = []
  const stop = subscribeExtensionMountPoints(() => snapshots.push(getExtensionMountPointsVersion()))
  try {
    recordExtensionMountPoint('first', 'settings_extensions')
    recordExtensionMountPoint('first', 'settings_extensions')
    recordExtensionMountPoint('second', 'settings_extensions')
    expect(snapshots).toEqual([version + 1, version + 2])
    expect(hasExtensionMountPoint('first', 'settings_extensions')).toBe(true)
    clearExtensionMountPoints('first')
    clearExtensionMountPoints('first')
    expect(hasExtensionMountPoint('first', 'settings_extensions')).toBe(false)
    expect(hasExtensionMountPoint('second', 'settings_extensions')).toBe(true)
    expect(snapshots).toEqual([version + 1, version + 2, version + 3])
    stop()
    clearExtensionMountPoints('second')
    expect(snapshots).toHaveLength(3)
    expect(getExtensionMountPointsVersion()).toBe(version + 4)
  } finally {
    stop()
    clearExtensionMountPoints('first')
    clearExtensionMountPoints('second')
  }
})
