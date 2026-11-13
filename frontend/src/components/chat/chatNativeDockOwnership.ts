interface QuickToolbarOwnershipSettings {
  enabled?: boolean
  visibleTabIds?: readonly string[]
}

export function quickToolbarOwnsOldestMessage(
  suiteEnabled: boolean,
  settings: QuickToolbarOwnershipSettings | null | undefined,
): boolean {
  return suiteEnabled
    && settings?.enabled !== false
    && settings?.visibleTabIds?.includes('chat.scroll-to-top') === true
}

/** The one chat-docker action the native dock and the Quick Toolbar can share. */
export const OLDEST_MESSAGE_ACTION_ID = 'chat.scroll-to-top'

/**
 * Marks the native dock's own copy of a shared chat-docker action, so a
 * rendered-ownership probe can tell "the Quick Toolbar really renders this"
 * apart from "the native control is still standing here".
 */
export const NATIVE_DOCK_ACTION_ATTRIBUTE = 'data-native-dock-action'

const OLDEST_MESSAGE_TOOLBAR_SELECTOR =
  `[data-toolbar-action="${OLDEST_MESSAGE_ACTION_ID}"]:not([${NATIVE_DOCK_ACTION_ATTRIBUTE}])`

/**
 * The rendered half of the oldest-message ownership decision.
 *
 * `quickToolbarOwnsOldestMessage` can only read the persisted settings, but the
 * Quick Toolbar action is not always rendered when those settings say it is: the
 * floating toolbar exists only while the Suite mounts its host surface, it hides
 * itself behind an overlay, `useQuickToolbarActions` normalizes legacy/default
 * `visibleTabIds` away, docked V2 can pack an action into its overflow list, and
 * an extension may replace the whole component. In each of those cases the raw
 * setting hands ownership to a control that is not there, and an eligible chat
 * ends up with no oldest-message action at all.
 *
 * Returns `true` when there is no document to inspect, so server rendering and
 * the first client commit keep the settings-derived answer instead of flashing a
 * duplicate native control before the toolbar has mounted.
 */
export function quickToolbarRendersOldestMessageAction(
  root: Pick<Document, 'querySelector'> | null | undefined,
): boolean {
  if (!root) return true
  return root.querySelector(OLDEST_MESSAGE_TOOLBAR_SELECTOR) !== null
}
