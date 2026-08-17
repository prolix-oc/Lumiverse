export const PRODUCTIVITY_FEATURE_FLAGS = [
  'showEmbeddingFallbackUi',
  'showCortexSecondaryUi',
  'showEditAndSend',
  'enableToolbarIconReorder',
] as const

export type ProductivityFeatureFlag = typeof PRODUCTIVITY_FEATURE_FLAGS[number]

/** Missing or non-false values stay ON so legacy rows keep current surfaces. */
export function readProductivityFlag(
  settings: Partial<Record<ProductivityFeatureFlag, unknown>> | null | undefined,
  key: ProductivityFeatureFlag,
): boolean {
  return settings?.[key] !== false
}
