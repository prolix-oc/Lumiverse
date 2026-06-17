import { useRef, useEffect } from 'react'
import { useStore } from '@/store'
import { ensureRegistryRoot } from '@/lib/drawer-tab-registry'
import ErrorBoundary from '@/components/shared/ErrorBoundary'
import type { TabLocation } from '@/lib/spindle/tab-mobility-types'

interface Props {
  tabId: string
  location: TabLocation
}

/**
 * Unified tab host — looks up a tab's persistent root (built-in via
 * `ensureRegistryRoot`, extension via `drawerTabs.find(...).root`) and
 * mounts it into a stable container via `replaceChildren`.
 *
 * The `<ErrorBoundary>` is keyed on `tabId+location` so React does not
 * reset the boundary when the location changes.
 */
export default function TabPanelContent({ tabId, location }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const drawerTabs = useStore((s) => s.drawerTabs)
  const tabLocations = useStore((s) => s.tabLocations)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    // If the tab belongs to a different location, do NOT mount it here —
    // let the container that owns it handle the root.
    const currentLocation = tabLocations[tabId] ?? { kind: 'main-drawer' } as const
    const isMatch =
      currentLocation.kind === location.kind &&
      (currentLocation.kind === 'main-drawer' || (location.kind === 'container' && currentLocation.kind === 'container' && currentLocation.containerId === location.containerId))
    if (!isMatch) {
      el.replaceChildren()
      return
    }

    // Built-in tabs have a persistent root lazily mounted on first view
    const registryRoot = ensureRegistryRoot(tabId)
    // Extension tabs store their root in the drawerTabs slice
    const extTab = drawerTabs.find((t) => t.id === tabId)
    const root = registryRoot ?? extTab?.root

    if (root) {
      // Avoid replaceChildren when root is already mounted — it clears
      // then re-appends, causing a 1-frame empty/black flash.
      if (el.firstChild !== root) {
        el.replaceChildren(root)
      }
    } else {
      // No root yet — clear any stale content so the previous tab's
      // panel doesn't linger visually.
      el.replaceChildren()
    }
  }, [tabId, location, drawerTabs, tabLocations])

  // Determine a display label for the error boundary
  const label = tabId

  return (
    <ErrorBoundary key={`${tabId}:${location.kind}${location.kind === 'container' ? `:${location.containerId}` : ''}`} label={label}>
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%' }}
      />
    </ErrorBoundary>
  )
}
