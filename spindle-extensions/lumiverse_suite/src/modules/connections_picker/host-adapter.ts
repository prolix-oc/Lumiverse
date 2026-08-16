import type { ConnectionPickerModel, ConnectionPickerProfile, ConnectionPickerTag, ConnectionsPickerRect, ConnectionsPickerVariant } from './types'

interface HostProfile {
  readonly id: string
  readonly name: string
  readonly provider: string
  readonly model?: string
  readonly metadata?: Record<string, unknown>
}

interface ModelsResult {
  readonly models?: readonly string[]
  readonly model_labels?: Readonly<Record<string, string>>
}

interface ContributionHandle { readonly root: HTMLElement; destroy(): void }

export interface ConnectionsPickerHostContract {
  readonly connections?: {
    list(): readonly HostProfile[] | Promise<readonly HostProfile[]>
    getActive?(): { readonly activeProfileId?: string | null } | string | null | Promise<{ readonly activeProfileId?: string | null } | string | null>
    models(profileId: string): Promise<ModelsResult | readonly ConnectionPickerModel[]>
    setActive(profileId: string | null): void | Promise<void>
    update?(profileId: string, patch: { model?: string }): Promise<unknown>
  }
  readonly ui?: {
    mount?(point: string): Element
    createFloatWidget?(options: { id: string; key: string; title: string; width?: number; height?: number; initialPosition?: { x: number; y: number }; chromeless?: boolean; resizable?: boolean; snapToEdge?: boolean; persistGeometry?: string; mobileClamp?: boolean; onGeometryCommit?(rect: ConnectionsPickerRect): void }): ContributionHandle
    geometry?: { layoutElementRect?(element: Element): ConnectionsPickerRect; createResizeController(element: HTMLElement, options: { onCommit(rect: ConnectionsPickerRect): void }): (() => void) | { destroy(): void } }
    registerSettingsTab?(options: { id: string; title: string; shortName?: string; description?: string; keywords?: readonly string[]; order?: number; sections?: readonly unknown[] }): ContributionHandle
    registerConnectionEditorTab?(options: { id: string; title: string; order?: number }): ContributionHandle
    connectionEditor?: {
      getEditedProfileId(): string | null
      onChange(handler: () => void): () => void
      onSaved(handler: () => void): () => void
    }
  }
}

export interface ConnectionsPickerHostAdapter {
  list(): Promise<readonly ConnectionPickerProfile[]>
  getActive(): Promise<string | null>
  models(profileId: string): Promise<readonly ConnectionPickerModel[]>
  setActive(profileId: string, modelId?: string): Promise<boolean>
  createSurface(variant: ConnectionsPickerVariant, rect: ConnectionsPickerRect, onCommit: (rect: ConnectionsPickerRect) => void, floating?: boolean): ContributionHandle | undefined
  registerLauncher(onInvoke: () => void): () => void
  registerSettings(render: (root: HTMLElement) => () => void): () => void
  registerTagEditor(
    getTags: () => readonly ConnectionPickerTag[],
    getAssignedTagIds: (profileId: string) => readonly string[],
    setAssignedTagIds: (profileId: string, tagIds: readonly string[]) => Promise<void>,
  ): () => void
}

const noop = () => undefined
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function redactedProfile(profile: HostProfile): ConnectionPickerProfile {
  const tagIds = isRecord(profile.metadata) && Array.isArray(profile.metadata.tagIds)
    ? profile.metadata.tagIds.filter((value): value is string => typeof value === 'string')
    : []
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    model: typeof profile.model === 'string' ? profile.model : '',
    tagIds,
    isModelRoulette: profile.provider === 'model_roulette',
  }
}

function disposer(value: (() => void) | { destroy(): void } | undefined): () => void {
  if (typeof value === 'function') return value
  return value ? () => value.destroy() : noop
}
export interface ConnectionsPickerSelectionQueue {
  run(operation: () => Promise<void>): Promise<void>
}

export function createConnectionsPickerSelectionQueue(): ConnectionsPickerSelectionQueue {
  let tail: Promise<void> = Promise.resolve()
  return {
    run(operation) {
      const current = tail.then(operation)
      tail = current.catch(() => undefined)
      return current
    },
  }
}

/** Adapts the accepted H1/H5/H6/H10/H16 contracts without exposing credentials. */
export function createConnectionsPickerHostAdapter(ctx: ConnectionsPickerHostContract, selectionQueue = createConnectionsPickerSelectionQueue()): ConnectionsPickerHostAdapter {
  const api = ctx.connections
  return {
    async list() {
      const profiles = await api?.list() ?? []
      return profiles.map(redactedProfile)
    },
    async getActive() {
      const active = await api?.getActive?.() ?? null
      if (typeof active === 'string' || active === null) return active
      return typeof active.activeProfileId === 'string' ? active.activeProfileId : null
    },
    async models(profileId) {
      const result = await api?.models(profileId)
      if (Array.isArray(result)) return result.map(model => ({ ...model }))
      const payload = result as ModelsResult | undefined
      if (!payload || !Array.isArray(payload.models)) return []
      return payload.models.map(id => ({ id, label: payload.model_labels?.[id] }))
    },
    async setActive(profileId, modelId) {
      if (!api?.setActive || (modelId && !api.update)) return false
      await selectionQueue.run(async () => {
        if (modelId) await api.update!(profileId, { model: modelId })
        await api.setActive(profileId)
      })
      return true
    },
    createSurface(variant, rect, onCommit, floating = false) {
      if (floating) {
        let initialPosition = { x: rect.x, y: rect.y }
        if (variant === 'A') {
          const anchor = ctx.ui?.mount?.('chat_actions')
          const anchorRect = anchor ? ctx.ui?.geometry?.layoutElementRect?.(anchor) : undefined
          if (anchorRect) initialPosition = { x: anchorRect.x, y: Math.max(0, anchorRect.y - rect.height - 8) }
        }
        return ctx.ui?.createFloatWidget?.({
          id: 'connections-picker',
          key: 'connections_picker',
          title: 'Connections',
          width: rect.width,
          height: rect.height,
          initialPosition,
          chromeless: true,
          resizable: true,
          snapToEdge: false,
          persistGeometry: 'connections_picker',
          mobileClamp: true,
          onGeometryCommit: onCommit,
        })
      }
      // Older hosts may expose mount() but not this optional catalog point.
      let mount: Element | undefined
      try { mount = ctx.ui?.mount?.('chat_surface_side') } catch { mount = undefined }
      if (!(mount instanceof HTMLElement)) return undefined
      const root = mount.ownerDocument.createElement('section')
      mount.append(root)
      const disposeResize = disposer(ctx.ui?.geometry?.createResizeController(root, { onCommit }))
      return { root, destroy: () => { disposeResize(); root.remove() } }
    },
    registerLauncher(onInvoke) {
      const mount = ctx.ui?.mount?.('chat_actions')
      if (!(mount instanceof HTMLElement)) return noop
      const button = mount.ownerDocument.createElement('button')
      button.type = 'button'
      button.setAttribute('aria-label', 'Open connections picker')
      button.dataset.lumiverseModule = 'connections_picker'
      button.textContent = 'Connections'
      button.addEventListener('click', onInvoke)
      mount.append(button)
      return () => { button.removeEventListener('click', onInvoke); button.remove() }
    },
    registerSettings(render) {
      // Productivity owns one suite-level settings registration. Keep this
      // compatibility method as an inert disposer for older callers.
      void render
      return noop
    },
    registerTagEditor(getTags, getAssignedTagIds, setAssignedTagIds) {
      const handle = ctx.ui?.registerConnectionEditorTab?.({ id: 'connections_picker_tags', title: 'Connection tags', order: 20 })
      const bridge = ctx.ui?.connectionEditor
      if (!handle || !bridge) return noop
      const render = () => {
        handle.root.replaceChildren()
        const profileId = bridge.getEditedProfileId()
        if (!profileId) return
        const assigned = new Set(getAssignedTagIds(profileId))
        for (const tag of getTags()) {
          const doc = handle.root.ownerDocument
          const label = doc.createElement('label')
          const input = doc.createElement('input')
          input.type = 'checkbox'
          input.checked = assigned.has(tag.id)
          input.addEventListener('change', () => {
            if (input.checked) assigned.add(tag.id); else assigned.delete(tag.id)
            void setAssignedTagIds(profileId, [...assigned])
          })
          const swatch = doc.createElement('span')
          swatch.style.backgroundColor = tag.color
          swatch.setAttribute('aria-hidden', 'true')
          label.append(input, swatch, doc.createTextNode(tag.name))
          handle.root.append(label)
        }
      }
      const stopChange = bridge.onChange(render)
      const stopSaved = bridge.onSaved(render)
      render()
      return () => { stopSaved(); stopChange(); handle.destroy() }
    },
  }
}
