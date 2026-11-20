/**
 * Landing-page tab model.
 *
 * React-free on purpose: the repo has no DOM test environment, so every real
 * decision (which ids the ARIA wiring uses, what an arrow key resolves to, how
 * a persisted-but-unknown value is normalised) lives here where it can be
 * unit-tested directly. `LandingPage.tsx` only wires these results to markup.
 */

export const LANDING_PAGE_TABS = ['characters', 'chats'] as const

export type LandingPageTab = (typeof LANDING_PAGE_TABS)[number]

/** The Characters tab is the landing default — it renders without a fetch. */
export const DEFAULT_LANDING_PAGE_TAB: LandingPageTab = 'characters'

export function isLandingPageTab(value: unknown): value is LandingPageTab {
  return typeof value === 'string' && (LANDING_PAGE_TABS as readonly string[]).includes(value)
}

/** What the page knows about whether a tab has anything to show. */
export interface LandingPageTabAvailability {
  /**
   * `homepageCharacterLibrarySettings.enabled`. `HomepageCharacterLibrary`
   * returns `null` when it is off, so offering a Characters tab would hand the
   * user a blank panel with nothing in it and no way to fix it from the page.
   */
  characterLibraryEnabled: boolean
}

/**
 * The tabs that actually have content right now, in tablist order.
 *
 * Never empty: Chats always renders something (list, empty state or error), so
 * every caller can treat the result as a non-empty list.
 */
export function getAvailableLandingPageTabs(
  availability: LandingPageTabAvailability,
): readonly LandingPageTab[] {
  if (availability.characterLibraryEnabled) return LANDING_PAGE_TABS
  return LANDING_PAGE_TABS.filter((tab) => tab !== 'characters')
}

/** Defensive: an empty/garbage availability list falls back to the full set. */
function usableTabs(available: readonly LandingPageTab[]): readonly LandingPageTab[] {
  return available.length > 0 ? available : LANDING_PAGE_TABS
}

/**
 * Coerce anything the settings row can hand back (missing key, stale value from
 * an older build, `null` from a cleared column) to a tab that exists.
 *
 * `available` narrows that further to the tabs currently rendered, so a stored
 * `'characters'` cannot strand the user on a tab the tablist is not offering.
 * The stored value is deliberately left alone — re-enabling the character
 * library restores the user's original choice instead of a value we overwrote.
 */
export function normalizeLandingPageTab(
  value: unknown,
  available: readonly LandingPageTab[] = LANDING_PAGE_TABS,
): LandingPageTab {
  const tabs = usableTabs(available)
  if (isLandingPageTab(value) && tabs.includes(value)) return value
  return tabs.includes(DEFAULT_LANDING_PAGE_TAB) ? DEFAULT_LANDING_PAGE_TAB : tabs[0]
}

/** DOM id of the `role="tab"` button — the target of the panel's aria-labelledby. */
export function landingPageTabId(tab: LandingPageTab): string {
  return `landing-tab-${tab}`
}

/** DOM id of the `role="tabpanel"` — the target of the tab's aria-controls. */
export function landingPageTabPanelId(tab: LandingPageTab): string {
  return `landing-tabpanel-${tab}`
}

/**
 * Roving-focus resolution for a horizontal tablist.
 *
 * Returns the tab the key should move to, or `null` when the key is not one the
 * tablist owns (so the caller leaves the event alone — no `preventDefault` on
 * Tab, Enter, typing, etc.). Left/Right wrap around; Home/End jump to the ends.
 *
 * Everything is resolved against `available` — the tabs actually rendered —
 * not the full set, or an arrow press in a shrunken tablist would select a tab
 * that has no button to move focus to. With a single available tab every owned
 * key resolves to that tab (focus stays put, the key is still consumed).
 */
export function resolveTabArrowKey(
  key: string,
  current: LandingPageTab,
  available: readonly LandingPageTab[] = LANDING_PAGE_TABS,
): LandingPageTab | null {
  const tabs = usableTabs(available)
  // `indexOf` after normalising against the same list: never -1, so the
  // negative-wrap arithmetic below always starts from a real index.
  const index = tabs.indexOf(normalizeLandingPageTab(current, tabs))

  switch (key) {
    case 'ArrowLeft':
      return tabs[(index - 1 + tabs.length) % tabs.length]
    case 'ArrowRight':
      return tabs[(index + 1) % tabs.length]
    case 'Home':
      return tabs[0]
    case 'End':
      return tabs[tabs.length - 1]
    default:
      return null
  }
}
