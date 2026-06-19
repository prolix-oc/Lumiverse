/**
 * Local type definitions for tab mobility (v0.5.24 placeholder).
 *
 * TODO(remove-when-bumped): Delete this file once `lumiverse-spindle-types`
 * is bumped to `^0.5.24` in `frontend/package.json` (currently `^0.5.23`).
 * The v0.5.24 precursor PR (j-dandelion/lumiverse-spindle-types
 * feat/tab-mobility-v0.5.24) ships a discriminated `SpindleTabLocation`
 * shape and the `containers` property in the package proper. Until then,
 * this file's module augmentation merges the types into the package's
 * `SpindleFrontendContext` interface, and the local declarations here
 * are load-bearing.
 */

/** Where a built-in drawer tab currently lives. */
export type TabLocation =
  | { kind: 'main-drawer' }
  | { kind: 'container'; containerId: string }

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

export type SpindleTabMobilityUI = SpindleFrontendContext['ui'] & {
  requestTabLocation(tabId: string, location: TabLocation): void
  getTabLocation(tabId: string): TabLocation
  getBuiltInTabTitle(tabId: string): string | undefined
  getBuiltInTabRoot(tabId: string): HTMLElement | undefined
}

declare module 'lumiverse-spindle-types' {
  interface SpindleFrontendContext {
    /** Register or unregister passive DOM containers that can receive tab roots. */
    containers: {
      /** Register a container element with a stable id. Tabs routed to this id via `requestTabLocation` will be reparented into `element`. Idempotent on id collision. */
      registerContainer(entry: { id: string; side: 'left' | 'right' | 'top' | 'bottom'; element: HTMLElement }): void
      /** Remove a previously registered container. Tabs still pointing to this id will fall back to the main drawer. */
      unregisterContainer(id: string): void
    }
  }
}
