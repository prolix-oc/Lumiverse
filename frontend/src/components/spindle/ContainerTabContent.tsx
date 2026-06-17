import { useEffect } from 'react'
import { useStore } from '@/store'
import { ensureRegistryRoot } from '@/lib/drawer-tab-registry'

/**
 * React renderer that re-parents tab persistent roots into registered
 * DOM containers (e.g. Canvas's secondary drawer, or any custom
 * container an extension registers via `registerContainer`).
 *
 * Subscribes to both `containers` (ContainerEntry[]) and `tabLocations`
 * (Record<string, TabLocation>). For each tab whose location is
 * `{ kind: 'container', containerId }`, it finds the matching
 * container element and calls `appendChild(root)` to mount the tab's
 * content there. Tabs whose target container is missing are reset to
 * `{ kind: 'main-drawer' }`.
 *
 * Renders nothing — all work is side-effect driven.
 */
export default function ContainerTabContent() {
  const containers = useStore((s) => s.containers)
  const tabLocations = useStore((s) => s.tabLocations)
  const drawerTabs = useStore((s) => s.drawerTabs)

  useEffect(() => {
    // Pass 1: mount tabs into their matching registered container
    for (const container of containers) {
      if (!container.element) continue

      for (const [tabId, location] of Object.entries(tabLocations)) {
        if (location.kind !== 'container') continue
        if (location.containerId !== container.id) continue

        const registryRoot = ensureRegistryRoot(tabId)
        const extTab = drawerTabs.find((t) => t.id === tabId)
        const root = registryRoot ?? extTab?.root
        if (!root) continue

        if (!container.element.contains(root)) {
          container.element.appendChild(root)
        }
      }
    }

    // Pass 2: remove stale roots from containers that no longer own the tab
    for (const container of containers) {
      if (!container.element) continue

      for (const [tabId, location] of Object.entries(tabLocations)) {
        const registryRoot = ensureRegistryRoot(tabId)
        const extTab = drawerTabs.find((t) => t.id === tabId)
        const root = registryRoot ?? extTab?.root
        if (!root) continue

        const belongsHere =
          location.kind === 'container' && location.containerId === container.id
        if (!belongsHere && container.element.contains(root)) {
          container.element.removeChild(root)
        }
      }
    }

    // Pass 3: fallback — tabs pointing to a missing container reset to main-drawer
    const { moveTabTo } = useStore.getState()
    for (const [tabId, location] of Object.entries(tabLocations)) {
      if (location.kind !== 'container') continue
      if (containers.some((c) => c.id === location.containerId)) continue
      moveTabTo(tabId, { kind: 'main-drawer' })
    }
  }, [containers, tabLocations, drawerTabs])

  return null
}
