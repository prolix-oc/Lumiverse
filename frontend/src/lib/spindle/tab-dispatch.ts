import { CORE_DRAWER_TAB_IDS } from '@/lib/core-drawer-tab-ids'

/**
 * Pure dispatch-authorization check for `requestTabLocation`. Exported
 * for testability — the runtime call site reads the live store, but
 * the rule is a pure function of (tabId, extensionId, the slice of
 * extension-owned drawer tabs).
 *
 * Returns true iff `tabId` is either a CORE_DRAWER_TAB_IDS entry or a
 * drawer tab owned by `extensionId`. Other-extension tabs and unknown
 * tab ids are denied.
 */
export function isTabDispatchable(
  tabId: string,
  extensionId: string,
  ownDrawerTabs: ReadonlyArray<{ id: string; extensionId: string }>,
): boolean {
  if (CORE_DRAWER_TAB_IDS.has(tabId)) return true
  return ownDrawerTabs.some((t) => t.id === tabId && t.extensionId === extensionId)
}
