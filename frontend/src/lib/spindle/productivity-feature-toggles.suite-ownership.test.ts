/**
 * Suite-owned productivity flags must return to their native default the moment
 * the LumiVerse Suite frontend stops being available.
 *
 * Reported defect: enabling "Cortex secondary connections" and "Embedding
 * fallback profiles" and then DISABLING the extension left both surfaces
 * mounted. Unticking the same checkboxes did hide them, because the surfaces
 * honoured an explicit persisted false but knew nothing about Suite
 * availability.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  PRODUCTIVITY_FEATURE_FLAGS,
  SUITE_OWNED_PRODUCTIVITY_FLAGS,
  isSuiteOwnedProductivityFlag,
  readProductivityFeature,
  readProductivityFlag,
  type ProductivityFeatureFlag,
} from './productivity-feature-toggles'

const SUITE_ENABLED = [{ identifier: 'lumiverse_suite', enabled: true, has_frontend: true }]
const SUITE_DISABLED = [{ identifier: 'lumiverse_suite', enabled: false, has_frontend: true }]
const SUITE_BACKEND_ONLY = [{ identifier: 'lumiverse_suite', enabled: true, has_frontend: false }]
const SUITE_ABSENT = [{ identifier: 'some_other_extension', enabled: true, has_frontend: true }]

type FlagState = Partial<Record<ProductivityFeatureFlag, unknown>> & { extensions?: unknown }

const REPORTED_FLAGS: ProductivityFeatureFlag[] = ['showCortexSecondaryUi', 'showEmbeddingFallbackUi']

describe('readProductivityFeature — Suite ownership gate', () => {
  test('the two reported flags are Suite-owned', () => {
    for (const flag of REPORTED_FLAGS) {
      expect(isSuiteOwnedProductivityFlag(flag)).toBe(true)
      expect(SUITE_OWNED_PRODUCTIVITY_FLAGS.has(flag)).toBe(true)
    }
  })

  test('the native composer customizer remains available without Suite', () => {
    const flag = 'showComposerCustomizeGear'
    expect(isSuiteOwnedProductivityFlag(flag)).toBe(false)
    expect(readProductivityFeature({ [flag]: true, extensions: SUITE_ABSENT }, flag)).toBe(true)
    expect(readProductivityFeature({ [flag]: false, extensions: SUITE_ENABLED }, flag)).toBe(false)
  })

  test('a persisted true does not survive an unavailable Suite', () => {
    for (const flag of PRODUCTIVITY_FEATURE_FLAGS) {
      if (!isSuiteOwnedProductivityFlag(flag)) continue
      for (const extensions of [SUITE_DISABLED, SUITE_BACKEND_ONLY, SUITE_ABSENT, [], undefined]) {
        expect(readProductivityFeature({ [flag]: true, extensions }, flag)).toBe(false)
        // Missing keys default to on, and must be gated the same way.
        expect(readProductivityFeature({ extensions }, flag)).toBe(false)
      }
      expect(readProductivityFeature(null, flag)).toBe(false)
      expect(readProductivityFeature(undefined, flag)).toBe(false)
    }
  })

  test('with the Suite enabled the persisted value is authoritative again', () => {
    for (const flag of PRODUCTIVITY_FEATURE_FLAGS) {
      expect(readProductivityFeature({ [flag]: true, extensions: SUITE_ENABLED }, flag)).toBe(true)
      expect(readProductivityFeature({ extensions: SUITE_ENABLED }, flag)).toBe(true)
      expect(readProductivityFeature({ [flag]: 'legacy-on', extensions: SUITE_ENABLED }, flag)).toBe(true)
      // The checkbox path still works: an explicit false hides the surface.
      expect(readProductivityFeature({ [flag]: false, extensions: SUITE_ENABLED }, flag)).toBe(false)
    }
  })

  test('readProductivityFlag stays a pure persisted read for the settings checkboxes', () => {
    for (const flag of PRODUCTIVITY_FEATURE_FLAGS) {
      // Bound to consts so the excess extensions key is not rejected by a
      // fresh-literal check: the point is that this reader ignores it entirely.
      const suiteOff = { [flag]: true, extensions: SUITE_DISABLED } as FlagState
      const suiteOn = { [flag]: false, extensions: SUITE_ENABLED } as FlagState
      expect(readProductivityFlag(suiteOff, flag)).toBe(true)
      expect(readProductivityFlag(suiteOn, flag)).toBe(false)
      expect(readProductivityFlag(undefined, flag)).toBe(true)
    }
  })
})

describe('the reported surfaces consult the Suite-aware reader', () => {
  const SRC = resolve(import.meta.dir, '../..')
  const cases: Array<{ file: string; flag: string }> = [
    { file: 'components/settings/MemoryCortexSettings.tsx', flag: 'showCortexSecondaryUi' },
    { file: 'components/modals/SettingsModal.tsx', flag: 'showEmbeddingFallbackUi' },
    { file: 'components/chat/MessageEditArea.tsx', flag: 'showEditAndSend' },
    { file: 'components/chat/InputArea.tsx', flag: 'showComposerCustomizeGear' },
    { file: 'components/quick-toolbar/QuickToolbar.tsx', flag: 'enableToolbarIconReorder' },
  ]

  for (const entry of cases) {
    test(`${entry.file} gates ${entry.flag} through readProductivityFeature`, () => {
      const source = readFileSync(resolve(SRC, entry.file), 'utf8')
      expect(source).toContain(`readProductivityFeature(`)
      expect(source).toContain(entry.flag)
      // The raw persisted read belongs to the settings checkboxes only.
      expect(source).not.toContain('readProductivityFlag(')
    })
  }

  test('the settings panel keeps reading persisted values and shares one ownership list', () => {
    const source = readFileSync(resolve(SRC, 'components/settings/ProductivityFeatureToggles.tsx'), 'utf8')
    expect(source).toContain('readProductivityFlag(')
    expect(source).toContain('SUITE_OWNED_PRODUCTIVITY_FLAGS')
    // A second, local ownership list is what drifted out of sync originally.
    expect(source).not.toContain('const SUITE_FEATURE_FLAGS')
  })
})
