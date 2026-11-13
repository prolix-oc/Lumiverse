/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { isTabDispatchable } from './tab-dispatch'

// `isTabDispatchable` is the pure dispatch-authorization check that
// gates `requestTabLocation` in placement-helper. The CORE ids are
// hard-coded here (rather than imported from drawer-tab-registry)
// because the registry transitively imports the store graph, which
// references Vite-only `import.meta.glob` that bun:test cannot
// resolve. Keeping the test self-contained avoids the import chain
// while still exercising the same authorization rule.

const CORE_IDS = ['profile', 'presets', 'loom', 'characters', 'personas', 'branches', 'spindle', 'theme', 'lorebook'] as const

const ownTabs = [
  { id: 'ext-tab-1', extensionId: 'ext-A' },
  { id: 'ext-tab-2', extensionId: 'ext-B' },
]

describe('isTabDispatchable', () => {
  test('returns true for any CORE_DRAWER_TAB_ID', () => {
    for (const core of CORE_IDS) {
      expect(isTabDispatchable(core, 'ext-A', ownTabs)).toBe(true)
    }
  })

  test('returns true for a drawer tab owned by the calling extension', () => {
    expect(isTabDispatchable('ext-tab-1', 'ext-A', ownTabs)).toBe(true)
  })

  test('returns false for a drawer tab owned by a different extension', () => {
    expect(isTabDispatchable('ext-tab-2', 'ext-A', ownTabs)).toBe(false)
  })

  test('returns false for an unknown tab id', () => {
    expect(isTabDispatchable('not-a-real-tab', 'ext-A', ownTabs)).toBe(false)
  })

  test('returns false for an empty string that is not in the CORE set', () => {
    expect(isTabDispatchable('', 'ext-A', ownTabs)).toBe(false)
  })

  test('returns false when ownDrawerTabs is empty and the tab is not CORE', () => {
    expect(isTabDispatchable('ext-tab-1', 'ext-A', [])).toBe(false)
  })

  test('the same tab id in two extensions is dispatchable only for the owner', () => {
    const shared = { id: 'shared-id', extensionId: 'ext-A' }
    const ownTabsWithShared = [...ownTabs, shared]
    expect(isTabDispatchable('shared-id', 'ext-A', ownTabsWithShared)).toBe(true)
    expect(isTabDispatchable('shared-id', 'ext-B', ownTabsWithShared)).toBe(false)
  })
})
