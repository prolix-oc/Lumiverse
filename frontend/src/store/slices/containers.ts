import type { StateCreator } from 'zustand'

/**
 * Container registration slice — tracks passive DOM containers that can
 * receive tab roots via `requestTabLocation(tabId, { kind: 'container', containerId })`.
 *
 * Any extension or core code can register a container with a stable id
 * and tabs routed to that id will be reparented into its element.
 * Tabs whose target id has no registered entry are reset to
 * `{ kind: 'main-drawer' }` by ContainerTabContent.
 */

export interface ContainerEntry {
  id: string
  side: 'left' | 'right' | 'top' | 'bottom'
  element: HTMLElement
}

export interface ContainersSlice {
  containers: ContainerEntry[]
  registerContainer(entry: ContainerEntry): void
  unregisterContainer(id: string): void
  getContainer(id: string): ContainerEntry | undefined
}

export const createContainersSlice: StateCreator<ContainersSlice> = (set, get) => ({
  containers: [],

  registerContainer(entry: ContainerEntry) {
    set((state) => {
      // Idempotent: replace on id collision
      const filtered = state.containers.filter((c) => c.id !== entry.id)
      return { containers: [...filtered, entry] }
    })
  },

  unregisterContainer(id: string) {
    set((state) => ({
      containers: state.containers.filter((c) => c.id !== id),
    }))
  },

  getContainer(id: string) {
    return get().containers.find((c) => c.id === id)
  },
})
