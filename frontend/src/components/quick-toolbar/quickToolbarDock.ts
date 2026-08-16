export const QUICK_TOOLBAR_PLACEMENTS = ['floating', 'chat_top_dock'] as const

export type QuickToolbarDockPlacement = (typeof QUICK_TOOLBAR_PLACEMENTS)[number]

export const QUICK_TOOLBAR_POINTER_HOLD_MS = 2000
export const QUICK_TOOLBAR_CHILD_FLEX = '0 0 auto'
export const QUICK_TOOLBAR_DOCK_ID = 'chat_top_dock'

export function normalizeQuickToolbarPlacement(value: unknown): QuickToolbarDockPlacement {
  return value === 'chat_top_dock' ? 'chat_top_dock' : 'floating'
}

export function readQuickToolbarPlacement(settings: {
  quickToolbarPlacement?: unknown
} | null | undefined): QuickToolbarDockPlacement {
  if (!settings || !('quickToolbarPlacement' in settings)) return 'floating'
  return normalizeQuickToolbarPlacement(settings.quickToolbarPlacement)
}

export function isAutoFitToolbarBounds(settings: {
  autoFitBounds?: unknown
} | null | undefined): boolean {
  return settings?.autoFitBounds !== false
}

export function isV2IconOnly(settings: {
  v2IconOnly?: unknown
  v2LabelVisible?: unknown
} | null | undefined): boolean {
  if (typeof settings?.v2IconOnly === 'boolean') return settings.v2IconOnly
  return settings?.v2LabelVisible === false
}

export function shouldUseNaturalToolbarSize({
  autoFitBounds,
  contentMetricsChanged,
}: {
  autoFitBounds?: unknown
  contentMetricsChanged: boolean
}): boolean {
  return autoFitBounds !== false || contentMetricsChanged
}
