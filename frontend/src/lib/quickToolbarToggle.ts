/**
 * Toggle semantics for quick toolbar buttons (QT-4: "pressing the same button
 * again does not close it").
 *
 * React-free, store-free and DOM-free, with its own narrow UI-state interface
 * instead of an `@/types/store` import, so it unit-tests headlessly.
 *
 * The decision lives here rather than in `store/slices/ui.ts` deliberately.
 * `openDrawer`/`openSettings` have 20+ non-toolbar callers — websocket
 * commands, deep links, extension requests — and every one of them is a
 * *make-visible* intent. Turning the shared store actions into toggles would
 * make a remote "open the lorebook drawer" *close* it whenever it was already
 * open. So the toolbar resolves an intent from a snapshot of the UI state at
 * click time and dispatches the matching open/close action.
 */

export type ToolbarSurface =
  | { kind: 'drawer'; tabId: string }
  | { kind: 'settings'; view: string }
  | { kind: 'command' }

/** The slice of UI state a toolbar button needs. Mirrors `UISlice`'s fields. */
export interface ToolbarUiState {
  drawerOpen: boolean
  drawerTab: string | null
  settingsModalOpen: boolean
  settingsActiveView: string
}

export type ToolbarIntent =
  | { type: 'open-drawer'; tabId: string }
  | { type: 'close-drawer' }
  | { type: 'open-settings'; view: string }
  | { type: 'close-settings' }
  | { type: 'run-command' }

/**
 * Whether the surface this button opens is the one currently showing.
 *
 * Drives the pressed affordance (`aria-pressed`, `.itemActive`, the V2 card
 * chevron) so the toggle is visible rather than a hidden behaviour. Commands
 * are never "active": they have no surface to close.
 */
export function isSurfaceActive(surface: ToolbarSurface, ui: ToolbarUiState): boolean {
  switch (surface.kind) {
    case 'drawer':
      return ui.drawerOpen && ui.drawerTab === surface.tabId
    case 'settings':
      return ui.settingsModalOpen && ui.settingsActiveView === surface.view
    case 'command':
      return false
  }
}

/**
 * Rendered pressed state. An explicit `active` flag wins even for commands,
 * so select-mode (and similar) can show `aria-pressed` without inventing a
 * drawer/settings surface. Undefined `active` keeps the existing surface rule.
 */
export function isToolbarActionActive(
  action: { active?: boolean; surface: ToolbarSurface },
  ui: ToolbarUiState,
): boolean {
  if (typeof action.active === 'boolean') return action.active
  return isSurfaceActive(action.surface, ui)
}

/**
 * Second press on the *same* surface closes it; a press on a *different* tab or
 * view switches to it and never closes. A command re-runs — it is an imperative
 * verb, and any idempotency is the command's own contract.
 *
 * Invariant asserted by the tests: `isSurfaceActive(s, ui)` is true exactly
 * when this returns a close intent.
 */
export function resolveToolbarIntent(surface: ToolbarSurface, ui: ToolbarUiState): ToolbarIntent {
  switch (surface.kind) {
    case 'drawer':
      return isSurfaceActive(surface, ui)
        ? { type: 'close-drawer' }
        : { type: 'open-drawer', tabId: surface.tabId }
    case 'settings':
      return isSurfaceActive(surface, ui)
        ? { type: 'close-settings' }
        : { type: 'open-settings', view: surface.view }
    case 'command':
      return { type: 'run-command' }
  }
}
