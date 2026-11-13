/**
 * Built-in drawer tabs that extensions can relocate via
 * `requestTabLocation`. Of the 24 entries in DRAWER_TABS, only these 9
 * are dispatchable to extensions — the remaining 15 (e.g. weaver) are
 * movable only via `core.store.requestTabLocation`. See
 * `ui-placement.md` Permissions for the full breakdown.
 */
export const CORE_DRAWER_TAB_IDS = new Set([
  'profile',
  'presets',
  'loom',
  'characters',
  'personas',
  'branches',
  'spindle',
  'theme',
  'lorebook',
])
