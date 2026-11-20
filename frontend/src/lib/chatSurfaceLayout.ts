import { keepDockEnabledWhenFloating } from '@/lib/uiProductivityDefaults'
import { readQuickToolbarPlacement } from '@/components/quick-toolbar/quickToolbarDock'

export type ChatTopDockMode = 'floating' | 'strip'
export type ChatLoreDockMode = 'hidden' | 'floating' | 'strip'

type QuickToolbarDockSettings = {
  quickToolbarPlacement?: unknown
  hideInChatTopDock?: unknown
}

const finiteNonNegative = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback

const finiteSum = (left: number, right: number): number => {
  const sum = left + right
  return Number.isFinite(sum) ? sum : Number.MAX_VALUE
}

export function chatTopDockMode(request: unknown): ChatTopDockMode {
  return request === 'strip' ? 'strip' : 'floating'
}

/**
 * Resolve the effective top-dock request for Quick Toolbar ownership.
 *
 * A docked toolbar always needs the strip rail. A floating toolbar may retain
 * that rail only while the legacy hide flag allows it. Invalid requests fail
 * closed to floating.
 */
export function effectiveQuickToolbarDockRequest(
  requested: unknown,
  settings: QuickToolbarDockSettings | null | undefined,
): ChatTopDockMode {
  const placement = readQuickToolbarPlacement(settings)
  if (requested === 'strip' && (placement === 'chat_top_dock' || keepDockEnabledWhenFloating(
    settings ? { hideInChatTopDock: settings.hideInChatTopDock === true } : undefined,
  ))) {
    return 'strip'
  }
  return 'floating'
}

export function chatLoreDockMode(request: unknown): ChatLoreDockMode {
  if (request === 'strip') return 'strip'
  return request === 'floating' ? 'floating' : 'hidden'
}

export function dockActionControlSize(iconSize: unknown, density: unknown): number {
  const size = typeof iconSize === 'number' && Number.isFinite(iconSize) && iconSize >= 0 ? iconSize : 16
  return finiteSum(size, density === 'compact' ? 8 : 20)
}

export function composeChatSafeZones(
  composerHeight: unknown,
  loreHeight: unknown,
  bottomOffset: unknown,
): { composerSafeZone: number; inputSafeZone: number } {
  const composer = finiteNonNegative(composerHeight)
  const lore = finiteNonNegative(loreHeight)
  const bottom = finiteNonNegative(bottomOffset)
  const composerSafeZone = finiteSum(composer, bottom)
  return { composerSafeZone, inputSafeZone: finiteSum(composerSafeZone, lore) }
}
