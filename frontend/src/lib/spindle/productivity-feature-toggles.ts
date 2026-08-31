import { hasEnabledFrontendExtension } from './frontend-extension-availability'

export const PRODUCTIVITY_FEATURE_FLAGS = [
  'showEmbeddingFallbackUi',
  'showCortexSecondaryUi',
  'showEditAndSend',
  'enableToolbarIconReorder',
  'showComposerCustomizeGear',
] as const

export type ProductivityFeatureFlag = typeof PRODUCTIVITY_FEATURE_FLAGS[number]

/**
 * Flags whose surfaces belong to LumiVerse Suite. Disabling the extension must
 * return every one of them to its native default, so this set is the single
 * authority for both the settings checkboxes and the surfaces they unlock.
 * Two lists is what let `showEmbeddingFallbackUi` and `showCortexSecondaryUi`
 * keep Suite-only UI mounted after the extension was disabled: the settings
 * panel knew they were Suite-owned, the surfaces did not.
 */
export const SUITE_OWNED_PRODUCTIVITY_FLAGS: ReadonlySet<ProductivityFeatureFlag> = new Set([
  'showEmbeddingFallbackUi',
  'showCortexSecondaryUi',
  'showEditAndSend',
  'enableToolbarIconReorder',
  'showComposerCustomizeGear',
])

export function isSuiteOwnedProductivityFlag(key: ProductivityFeatureFlag): boolean {
  return SUITE_OWNED_PRODUCTIVITY_FLAGS.has(key)
}

/**
 * The persisted value only. Missing or non-false values stay ON so legacy rows
 * keep current surfaces. Use this for the settings checkboxes, which must show
 * what is stored; use `readProductivityFeature` to decide whether a surface
 * may render.
 */
export function readProductivityFlag(
  settings: Partial<Record<ProductivityFeatureFlag, unknown>> | null | undefined,
  key: ProductivityFeatureFlag,
): boolean {
  return settings?.[key] !== false
}

type ProductivityFeatureState = Partial<Record<ProductivityFeatureFlag, unknown>> & {
  extensions?: Parameters<typeof hasEnabledFrontendExtension>[0]
}

/**
 * Whether a feature may render right now. A Suite-owned flag reverts to its
 * native default while the Suite frontend is unavailable, no matter what the
 * user persisted, so uninstalling or disabling the extension cannot leave
 * Suite-only controls behind. Non-Suite flags read straight through.
 */
export function readProductivityFeature(
  state: ProductivityFeatureState | null | undefined,
  key: ProductivityFeatureFlag,
): boolean {
  if (
    isSuiteOwnedProductivityFlag(key)
    && !hasEnabledFrontendExtension(state?.extensions, 'lumiverse_suite')
  ) {
    return false
  }
  return readProductivityFlag(state, key)
}
