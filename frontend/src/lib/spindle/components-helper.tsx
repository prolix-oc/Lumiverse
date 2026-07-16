import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import clsx from 'clsx'
import type {
  SpindleComponentTarget,
  SpindleComponentsHelper,
  SpindleLoomBlockEditorValue,
  SpindleLoomBlockEditorOptions,
  SpindleLoomBlockEditorHandle,
  SpindleConnectionRef,
  SpindleMountedComponent,
  SpindleTextInputOptions,
  SpindleTextInputHandle,
  SpindleTextAreaOptions,
  SpindleTextAreaHandle,
  SpindleNumericInputOptions,
  SpindleNumericInputHandle,
  SpindleNumberStepperOptions,
  SpindleNumberStepperHandle,
  SpindleRangeSliderOptions,
  SpindleRangeSliderHandle,
  SpindleRangeSliderFormat,
  SpindleCheckboxOptions,
  SpindleCheckboxHandle,
  SpindleSwitchOptions,
  SpindleSwitchHandle,
  SpindleSelectOption,
  SpindleSelectOptionLeading,
  SpindleSelectOptions,
  SpindleSelectHandle,
  SpindleMultiSelectOptions,
  SpindleMultiSelectHandle,
  SpindleModelComboboxOptions,
  SpindleModelComboboxHandle,
  SpindleFolderDropdownOptions,
  SpindleFolderDropdownHandle,
  SpindleBadgeOptions,
  SpindleBadgeHandle,
  SpindleSpinnerOptions,
  SpindleSpinnerHandle,
  SpindleCollapsibleSectionOptions,
  SpindleCollapsibleSectionHandle,
  SpindlePaginationOptions,
  SpindlePaginationHandle,
  SpindleCloseButtonOptions,
  SpindleCloseButtonHandle,
} from 'lumiverse-spindle-types'

import { TextInput, TextArea } from '@/components/shared/FormComponents'
import formStyles from '@/components/shared/FormComponents.module.css'
import NumericInput from '@/components/shared/NumericInput'
import NumberStepper from '@/components/shared/NumberStepper'
import { RangeSlider, LabeledRangeSlider } from '@/components/shared/RangeSlider'
import { Toggle } from '@/components/shared/Toggle'
import { Badge } from '@/components/shared/Badge'
import { Spinner } from '@/components/shared/Spinner'
import { CloseButton } from '@/components/shared/CloseButton'
import Pagination from '@/components/shared/Pagination'
import CollapsibleSection from '@/components/shared/CollapsibleSection'
import SearchableSelect, {
  PORTAL_OWNER_ACTIVE_ATTRIBUTE,
  PORTAL_OWNER_ACTIVITY_EVENT,
  type SearchableSelectOption,
} from '@/components/shared/SearchableSelect'
import FolderDropdown from '@/components/shared/FolderDropdown'
import ModelCombobox from '@/components/panels/connection-manager/ModelCombobox'
import { ControlledLoomBlockEditor } from '@/components/panels/LoomBuilder'
import { getAvailableMacros, normalizeCategoryBlockState, reconcilePromptVariableValues } from '@/lib/loom/service'
import type { MacroGroup, PromptBlock, PromptVariableValues } from '@/lib/loom/types'
import {
  cloneLoomOptions,
  cloneLoomValue,
  normalizeMacroCatalog,
  patchLoomOptions,
  type NormalizedLoomOptions,
} from './loom-dto'

import { useStore } from '@/store'
import { connectionsApi } from '@/api/connections'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import { ttsConnectionsApi } from '@/api/tts-connections'
import {
  getLiveRootRecord,
  getLiveRootRecords,
  subscribeLiveRoot,
  type LiveRootPermission,
} from './live-root-registry'

// ── Tracking & lifecycle ──────────────────────────────────────────────────

interface PortalNodeState {
  readonly hiddenAttribute: string | null
  readonly inertAttribute: string | null
  readonly styleAttribute: string | null
}

interface TrackedMount {
  root: Root
  ownerRoot: Element
  target: HTMLElement
  portalOwnerId: string
  portalNodes: Set<HTMLElement>
  portalNodeStates: Map<HTMLElement, PortalNodeState>
  generation: number
  requiredPermission: LiveRootPermission
  destroyed: boolean
  destroy(): void
  destroyAfterPortalIndex(): void
}

export type ComponentPermission = Exclude<LiveRootPermission, null>
const mountsByExtension = new Map<string, Set<TrackedMount>>()
const extensionGenerations = new Map<string, number>()
const lifecycleObservers = new Map<string, MutationObserver>()
const componentCleanupInProgress = new Set<string>()
let idCounter = 0

function nextId(extensionId: string, kind: string): string {
  return `spindle:${extensionId}:component:${kind}:${++idCounter}`
}

function currentGeneration(extensionId: string): number {
  return extensionGenerations.get(extensionId) ?? 0
}

function nextExtensionGeneration(extensionId: string): number {
  const generation = currentGeneration(extensionId) + 1
  extensionGenerations.set(extensionId, generation)
  return generation
}

function ownershipBoundary(element: Element): Element | null {
  let current: Element | null = element
  while (current) {
    if (
      current.hasAttribute('data-spindle-extension-root')
      || current.hasAttribute('data-spindle-ext')
    ) return current
    current = current.parentElement
  }
  return null
}

function isConnectedToDocument(element: Element): boolean {
  if (!element.isConnected) return false
  const documentElement = document.documentElement
  return documentElement ? documentElement.contains(element) : true
}

function isOwnedByExtension(extensionId: string, element: Element): boolean {
  const boundary = ownershipBoundary(element)
  if (!boundary) return false
  return boundary.getAttribute('data-spindle-extension-root') === extensionId
    || boundary.getAttribute('data-spindle-ext') === extensionId
}

function getPlacementRootRecord(
  extensionId: string,
  element: Element,
  generation?: number,
): { root: Element; extensionId: string; permission: LiveRootPermission } | null {
  return getLiveRootRecord(extensionId, element, generation)
}


function registeredPlacementRoot(extensionId: string, element: Element, generation?: number): Element | null {
  return getPlacementRootRecord(extensionId, element, generation)?.root ?? null
}

function componentPermissionForTarget(
  extensionId: string,
  target: Element,
  generation?: number,
): LiveRootPermission {
  const record = getPlacementRootRecord(extensionId, target, generation)
  return record?.permission ?? null
}

function assertComponentRegistrationAllowed(extensionId: string): void {
  if (componentCleanupInProgress.has(extensionId)) {
    throw new Error('COMPONENT_DESTROYED: Extension components are being torn down')
  }
}

function resolveTarget(
  extensionId: string,
  target: SpindleComponentTarget,
  expectedGeneration?: number,
): HTMLElement {
  assertComponentRegistrationAllowed(extensionId)
  if (expectedGeneration !== undefined && expectedGeneration !== currentGeneration(extensionId)) {
    throw new Error('components.mount*(): extension generation is no longer active')
  }
  const selectorTarget = typeof target === 'string'
  let resolved: Element | null
  if (selectorTarget) {
    const ownedMatches = new Set<Element>()
    try {
      for (const element of document.querySelectorAll(target)) ownedMatches.add(element)
      for (const record of getLiveRootRecords(extensionId, expectedGeneration)) {
        if (record.root.matches(target)) ownedMatches.add(record.root)
        for (const element of record.root.querySelectorAll(target)) ownedMatches.add(element)
      }
    } catch {
      throw new Error(`components.mount*(): invalid target selector: ${target}`)
    }
    const validMatches = [...ownedMatches].filter((element) =>
      isOwnedByExtension(extensionId, element)
      && registeredPlacementRoot(extensionId, element, expectedGeneration) !== null,
    )
    if (validMatches.length !== 1) {
      throw new Error(
        validMatches.length === 0
          ? `components.mount*(): target not found: ${target}`
          : `components.mount*(): target selector is ambiguous: ${target}`,
      )
    }
    resolved = validMatches[0] ?? null
  } else {
    resolved = target
  }

  if (!(resolved instanceof HTMLElement)) {
    throw new Error('components.mount*(): target must resolve to an HTMLElement')
  }
  const ownerRecord = getPlacementRootRecord(extensionId, resolved, expectedGeneration)
  if (!isOwnedByExtension(extensionId, resolved)) {
    throw new Error('components.mount*(): target must be inside DOM owned by the current extension')
  }
  if (!ownerRecord) {
    throw new Error('components.mount*(): target must be inside a registered placement owned by the current extension')
  }
  return resolved
}

function isMountLive(extensionId: string, mount: TrackedMount): boolean {
  if (mount.destroyed || mount.generation !== currentGeneration(extensionId)) return false
  if (!mount.ownerRoot.contains(mount.target)) return false
  const boundary = ownershipBoundary(mount.target)
  if (!boundary) return false
  const targetRecord = getLiveRootRecord(extensionId, mount.target, mount.generation)
  if (!targetRecord || targetRecord.root !== mount.ownerRoot) return false
  return boundary.getAttribute('data-spindle-extension-root') === extensionId
    || boundary.getAttribute('data-spindle-ext') === extensionId
}

function rememberPortalNode(mount: TrackedMount, node: HTMLElement): void {
  if (mount.portalNodes.has(node)) return
  mount.portalNodes.add(node)
  mount.portalNodeStates.set(node, {
    hiddenAttribute: node.getAttribute('hidden'),
    inertAttribute: node.getAttribute('inert'),
    styleAttribute: node.getAttribute('style'),
  })
}

function restorePortalNode(node: HTMLElement, state: PortalNodeState): void {
  if (state.hiddenAttribute === null) node.removeAttribute('hidden')
  else node.setAttribute('hidden', state.hiddenAttribute)
  if (state.inertAttribute === null) node.removeAttribute('inert')
  else node.setAttribute('inert', state.inertAttribute)
  if (state.styleAttribute === null) node.removeAttribute('style')
  else node.setAttribute('style', state.styleAttribute)
}

function setPortalOwnerActivity(node: HTMLElement, active: boolean): void {
  const value = active ? 'true' : 'false'
  if (node.getAttribute(PORTAL_OWNER_ACTIVE_ATTRIBUTE) === value) return
  node.setAttribute(PORTAL_OWNER_ACTIVE_ATTRIBUTE, value)
  const event = node.ownerDocument.createEvent('Event')
  event.initEvent(PORTAL_OWNER_ACTIVITY_EVENT, false, false)
  node.dispatchEvent(event)
}

function syncPortalVisibility(mount: TrackedMount): void {
  const ownerDetached = !isConnectedToDocument(mount.ownerRoot)
  for (const node of mount.portalNodes) {
    if (ownerDetached) {
      node.setAttribute('hidden', '')
      node.setAttribute('inert', '')
      setPortalOwnerActivity(node, false)
    } else {
      const state = mount.portalNodeStates.get(node)
      if (state) restorePortalNode(node, state)
      setPortalOwnerActivity(node, true)
    }
  }
}

function prunePortalNodes(mount: TrackedMount): void {
  for (const node of mount.portalNodes) {
    if (node.isConnected && document.body?.contains(node)) continue
    mount.portalNodes.delete(node)
    mount.portalNodeStates.delete(node)
  }
}

function indexPortalNodes(
  mounts: readonly TrackedMount[],
): void {
  if (mounts.length === 0) return
  for (const mount of mounts) prunePortalNodes(mount)
  if (!document.body) return
  const mountsByPortalOwner = new Map<string, TrackedMount>(
    mounts.map((mount) => [mount.portalOwnerId, mount]),
  )
  for (const node of document.body.querySelectorAll('[data-spindle-component-portal]')) {
    if (!(node instanceof HTMLElement)) continue
    const ownerId = node.getAttribute('data-spindle-component-portal')
    if (!ownerId) continue
    const mount = mountsByPortalOwner.get(ownerId)
    if (!mount) continue
    rememberPortalNode(mount, node)
  }
  for (const mount of mounts) syncPortalVisibility(mount)
}

function collectPortalNodes(mount: TrackedMount): void {
  prunePortalNodes(mount)
  if (!document.body) return
  for (const node of document.body.querySelectorAll('[data-spindle-component-portal]')) {
    if (!(node instanceof HTMLElement)) continue
    if (node.getAttribute('data-spindle-component-portal') !== mount.portalOwnerId) continue
    rememberPortalNode(mount, node)
  }
}

function observeExtensionMounts(extensionId: string, ownerRoot?: Element): void {
  let observer = lifecycleObservers.get(extensionId)
  if (!observer) {
    if (typeof MutationObserver === 'undefined') return
    observer = new MutationObserver(() => {
      const set = mountsByExtension.get(extensionId)
      if (!set) return
      const mounts = [...set]
      const staleMounts: TrackedMount[] = []
      const liveMounts: TrackedMount[] = []
      for (const mount of mounts) {
        if (!isMountLive(extensionId, mount)) staleMounts.push(mount)
        else liveMounts.push(mount)
      }
      indexPortalNodes(mounts)
      for (const mount of liveMounts) syncPortalVisibility(mount)
      for (const mount of staleMounts) {
        try { mount.destroyAfterPortalIndex() } catch { /* no-op */ }
      }
    })
    lifecycleObservers.set(extensionId, observer)
    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true, subtree: true })
    }
  }
  if (ownerRoot) observer.observe(ownerRoot, { childList: true, subtree: true })
}

function track(extensionId: string, mount: TrackedMount): void {
  assertComponentRegistrationAllowed(extensionId)
  let set = mountsByExtension.get(extensionId)
  if (!set) {
    set = new Set()
    mountsByExtension.set(extensionId, set)
  }
  set.add(mount)
  observeExtensionMounts(extensionId, mount.ownerRoot)
  collectPortalNodes(mount)
  syncPortalVisibility(mount)
}

function untrack(extensionId: string, mount: TrackedMount): void {
  const set = mountsByExtension.get(extensionId)
  if (!set) return
  set.delete(mount)
  if (set.size > 0) return
  mountsByExtension.delete(extensionId)
  lifecycleObservers.get(extensionId)?.disconnect()
  lifecycleObservers.delete(extensionId)
}

export function destroyComponentsForTarget(target: Element): void {
  for (const [extensionId, set] of mountsByExtension) {
    if (![...set].some((mount) => mount.target === target || target.contains(mount.target))) continue
    componentCleanupInProgress.add(extensionId)
    try {
      for (const mount of [...set]) {
        if (mount.target === target || target.contains(mount.target)) {
          try { mount.destroy() } catch { /* no-op */ }
        }
      }
    } finally {
      componentCleanupInProgress.delete(extensionId)
    }
  }
}

export function destroyComponentsForExtensionPermission(
  extensionId: string,
  permission: ComponentPermission,
  generation?: number,
): void {
  const set = mountsByExtension.get(extensionId)
  if (!set) return
  componentCleanupInProgress.add(extensionId)
  try {
    for (const mount of [...set]) {
      if (mount.requiredPermission !== permission) continue
      if (generation !== undefined && mount.generation !== generation) continue
      try { mount.destroy() } catch { /* no-op */ }
    }
  } finally {
    componentCleanupInProgress.delete(extensionId)
  }
}

export function destroyAllComponentsForExtension(
  extensionId: string,
  generation?: number,
): void {
  if (componentCleanupInProgress.has(extensionId)) return
  componentCleanupInProgress.add(extensionId)
  if (generation === undefined) nextExtensionGeneration(extensionId)
  try {
    const set = mountsByExtension.get(extensionId)
    if (set) {
      for (const mount of [...set]) {
        if (generation !== undefined && mount.generation !== generation) continue
        try { mount.destroy() } catch { /* no-op */ }
      }
    }
  } finally {
    componentCleanupInProgress.delete(extensionId)
  }
}

// ── Generic bridge primitive ──────────────────────────────────────────────

interface BridgeAPI<TOptions, TValue> {
  update(patch: Partial<TOptions>): void
  getValue(): TValue
  focus?(): void
  blur?(): void
  refresh?(): void
  open?(): void
  close?(): void
  refreshMacros?(): Promise<void>
  isExpanded?(): boolean
  body?: HTMLElement
  portalOwnerId?: string
  invalidate?(): void
}

interface MountResult<TOptions, TValue> {
  bridge: BridgeAPI<TOptions, TValue>
  root: Root
  portalOwnerId: string
}

function mountBridge<TOptions, TValue>(
  target: HTMLElement,
  render: (bridge: BridgeAPI<TOptions, TValue>) => ReactElement,
): MountResult<TOptions, TValue> {
  const portalOwnerId = `spindle:portal:${++idCounter}`
  const bridge: BridgeAPI<TOptions, TValue> = {
    update: () => {},
    getValue: () => undefined as unknown as TValue,
    portalOwnerId,
  }
  const root = createRoot(target)
  flushSync(() => {
    root.render(render(bridge))
  })
  return { bridge, root, portalOwnerId }
}

const COMPONENT_DESTROYED_ERROR = Object.freeze(new Error('COMPONENT_DESTROYED: Component handle is no longer live'))

function buildHandle<TOptions, TValue>(
  extensionId: string,
  componentId: string,
  target: HTMLElement,
  mount: MountResult<TOptions, TValue>,
  requiredPermission: LiveRootPermission,
): SpindleMountedComponent<TOptions> & { getValue(): TValue } & Omit<BridgeAPI<TOptions, TValue>, 'update' | 'getValue'> {
  const generation = currentGeneration(extensionId)
  const ownerRecord = getPlacementRootRecord(extensionId, target, generation)
  if (!ownerRecord) {
    mount.root.unmount()
    throw new Error('components.mount*(): target root was unregistered during mount')
  }
  let unsubscribeOwner = () => {}
  let tracked: TrackedMount
  const destroy = (skipPortalScan: boolean): void => {
    if (tracked.destroyed) return
    tracked.destroyed = true
    unsubscribeOwner()
    if (!skipPortalScan) collectPortalNodes(tracked)
    try {
      mount.bridge.invalidate?.()
    } catch { /* no-op */ }
    try {
      mount.root.unmount()
    } catch { /* no-op */ }
    for (const portal of [...tracked.portalNodes]) {
      try { portal.remove() } catch { /* no-op */ }
    }
    tracked.portalNodes.clear()
    tracked.portalNodeStates.clear()
    untrack(extensionId, tracked)
  }
  tracked = {
    root: mount.root,
    ownerRoot: ownerRecord.root,
    target,
    portalOwnerId: mount.portalOwnerId,
    portalNodes: new Set(),
    portalNodeStates: new Map(),
    generation,
    requiredPermission,
    destroyed: false,
    destroy: () => destroy(false),
    destroyAfterPortalIndex: () => destroy(true),
  }
  track(extensionId, tracked)
  unsubscribeOwner = subscribeLiveRoot(ownerRecord.root, tracked.destroy)

  const ensureLive = (): boolean => {
    if (isMountLive(extensionId, tracked)) return true
    tracked.destroy()
    return false
  }
  const handle = {
    componentId,
    element: target,
    update: (patch: Partial<TOptions>) => {
      if (!ensureLive()) throw COMPONENT_DESTROYED_ERROR
      mount.bridge.update(patch)
    },
    getValue: () => {
      if (!ensureLive()) throw COMPONENT_DESTROYED_ERROR
      return mount.bridge.getValue()
    },
    destroy: tracked.destroy,
    focus: () => {
      if (!ensureLive()) throw COMPONENT_DESTROYED_ERROR
      mount.bridge.focus?.()
    },
    blur: () => {
      if (!ensureLive()) throw COMPONENT_DESTROYED_ERROR
      mount.bridge.blur?.()
    },
    refresh: () => {
      if (!ensureLive()) throw COMPONENT_DESTROYED_ERROR
      mount.bridge.refresh?.()
    },
    refreshMacros: () => {
      if (!ensureLive()) return Promise.reject(COMPONENT_DESTROYED_ERROR)
      return mount.bridge.refreshMacros?.() ?? Promise.resolve()
    },
    open: () => {
      if (!ensureLive()) throw COMPONENT_DESTROYED_ERROR
      mount.bridge.open?.()
    },
    close: () => {
      if (!ensureLive()) throw COMPONENT_DESTROYED_ERROR
      mount.bridge.close?.()
    },
    isExpanded: () => {
      if (!ensureLive()) throw COMPONENT_DESTROYED_ERROR
      return mount.bridge.isExpanded?.() ?? false
    },
    get body() {
      if (!ensureLive()) throw COMPONENT_DESTROYED_ERROR
      return mount.bridge.body as HTMLElement
    },
  }
  return handle as SpindleMountedComponent<TOptions> & { getValue(): TValue } & Omit<BridgeAPI<TOptions, TValue>, 'update' | 'getValue'>
}

function cloneBridgeValue<TValue>(value: TValue): TValue {
  return Array.isArray(value) ? ([...value] as TValue) : value
}
function reportComponentCallbackFailure(label: string, error: unknown): void {
  console.error(`[Spindle] ${label} onChange callback failed`, error)
}

function observeComponentCallbackResult(label: string, result: unknown): void {
  if (result === null || (typeof result !== 'object' && typeof result !== 'function')) return
  try {
    void Promise.resolve(result).catch((error) => reportComponentCallbackFailure(label, error))
  } catch (error) {
    reportComponentCallbackFailure(label, error)
  }
}

function notifyComponentOnChange<TValue>(
  label: string,
  callback: ((value: TValue) => unknown) | undefined,
  value: TValue,
): unknown {
  if (!callback) return undefined
  try {
    const result = callback(value)
    observeComponentCallbackResult(label, result)
    return result
  } catch (error) {
    reportComponentCallbackFailure(label, error)
    return undefined
  }
}

// Hook that wires a bridge's update/getValue to local state.
function useBridgeBinding<TOptions, TValue>(
  bridge: BridgeAPI<TOptions, TValue>,
  props: TOptions,
  setProps: (next: TOptions | ((prev: TOptions) => TOptions)) => void,
  value: TValue,
  setValue: (next: TValue | ((prev: TValue) => TValue)) => void,
  valueKey?: keyof TOptions,
): (next: TValue) => TValue {
  const valueRef = useRef(cloneBridgeValue(value))
  valueRef.current = cloneBridgeValue(value)

  const commitValue = (next: TValue): TValue => {
    const stored = cloneBridgeValue(next)
    valueRef.current = stored
    setValue(stored)
    return cloneBridgeValue(stored)
  }

  useLayoutEffect(() => {
    bridge.update = (patch) => {
      if (valueKey && patch[valueKey] !== undefined) {
        const committed = commitValue(patch[valueKey] as unknown as TValue)
        setProps((prev) => ({ ...prev, ...patch, [valueKey]: committed }))
        return
      }
      setProps((prev) => ({ ...prev, ...patch }))
    }
    bridge.getValue = () => cloneBridgeValue(valueRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Sync valueKey patches that arrive via update — already handled in setProps callback.
  // Nothing else needed here.
  void props
  return commitValue
}

// ── Connection binding (LLM / Image / TTS) ────────────────────────────────

interface NormalizedModelList {
  models: string[]
  modelLabels: Record<string, string>
}

function useConnectionModels(connection: SpindleConnectionRef | undefined): {
  models: string[]
  modelLabels: Record<string, string>
  loading: boolean
  refresh: () => void
} {
  const activeId = useStore((s) => {
    if (!connection) return null
    if (connection.id) return connection.id
    if (connection.kind === 'llm') return s.activeProfileId ?? null
    if (connection.kind === 'image') return s.activeImageGenConnectionId ?? null
    if (connection.kind === 'tts') return s.voiceSettings?.ttsConnectionId ?? null
    return null
  })

  const [data, setData] = useState<NormalizedModelList>({ models: [], modelLabels: {} })
  const [loading, setLoading] = useState(false)
  const inflight = useRef(0)

  const refresh = useMemo(() => {
    return async () => {
      if (!connection || !activeId) {
        inflight.current += 1
        setData({ models: [], modelLabels: {} })
        setLoading(false)
        return
      }
      const token = ++inflight.current
      setLoading(true)
      try {
        if (connection.kind === 'llm') {
          const r = await connectionsApi.models(activeId)
          if (token !== inflight.current) return
          setData({ models: r.models ?? [], modelLabels: r.model_labels ?? {} })
        } else if (connection.kind === 'image') {
          const r = await imageGenConnectionsApi.models(activeId)
          if (token !== inflight.current) return
          const ids = (r.models ?? []).map((m) => m.id)
          const labels: Record<string, string> = {}
          for (const m of r.models ?? []) labels[m.id] = m.label
          setData({ models: ids, modelLabels: labels })
        } else if (connection.kind === 'tts') {
          const r = await ttsConnectionsApi.models(activeId)
          if (token !== inflight.current) return
          const ids = (r.models ?? []).map((m) => m.id)
          const labels: Record<string, string> = {}
          for (const m of r.models ?? []) labels[m.id] = m.label
          setData({ models: ids, modelLabels: labels })
        } else if (connection.kind === 'embedding') {
          throw new Error(
            'mountModelCombobox: connection.kind "embedding" is not yet supported in connection-bound mode. Use manual `models` instead.',
          )
        }
      } catch (err) {
        if (token === inflight.current) {
          setData({ models: [], modelLabels: {} })
          console.warn('[spindle:components] connection model fetch failed', err)
        }
      } finally {
        if (token === inflight.current) setLoading(false)
      }
    }
  }, [connection?.kind, connection?.id, activeId])

  useEffect(() => {
    if (!connection || !activeId) {
      inflight.current += 1
      setData({ models: [], modelLabels: {} })
      setLoading(false)
    }
    return () => {
      inflight.current += 1
    }
  }, [connection?.kind, connection?.id, activeId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { models: data.models, modelLabels: data.modelLabels, loading, refresh: () => { void refresh() } }
}

// ── Leading-cell renderer for select options ──────────────────────────────

function LeadingInitial({ text, background, color }: { text: string; background?: string; color?: string }) {
  return (
    <span
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '50%',
        background: background ?? 'var(--surface-2, rgba(255,255,255,0.08))',
        color: color ?? 'var(--text-2, currentColor)',
        fontSize: '11px',
        fontWeight: 600,
        lineHeight: 1,
        overflow: 'hidden',
      }}
    >
      {text}
    </span>
  )
}

function LeadingImage({
  src,
  alt,
  rounded,
  fallback,
}: {
  src: string
  alt?: string
  rounded?: boolean
  fallback?: { text: string; background?: string; color?: string }
}) {
  const [errored, setErrored] = useState(false)
  if (!src || errored) {
    if (fallback) return <LeadingInitial {...fallback} />
    return null
  }
  return (
    <img
      src={src}
      alt={alt ?? ''}
      loading="lazy"
      onError={() => setErrored(true)}
      style={{ borderRadius: rounded === false ? '4px' : '50%' }}
    />
  )
}

function renderLeading(leading: SpindleSelectOptionLeading | undefined): ReactElement | null {
  if (!leading) return null
  switch (leading.type) {
    case 'image':
      return (
        <LeadingImage
          src={leading.src}
          alt={leading.alt}
          rounded={leading.rounded}
          fallback={leading.fallback}
        />
      )
    case 'icon-url':
      return <img src={leading.url} alt={leading.alt ?? ''} loading="lazy" />
    case 'icon-svg':
      return (
        <span
          aria-hidden
          dangerouslySetInnerHTML={{ __html: leading.svg }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            height: '100%',
            color: leading.color ?? 'currentColor',
          }}
        />
      )
    case 'swatch':
      return (
        <span
          aria-hidden
          style={{
            width: '14px',
            height: '14px',
            borderRadius: '50%',
            background: leading.color,
            boxShadow: '0 0 0 1px rgba(0,0,0,0.2) inset',
          }}
        />
      )
    case 'initial':
      return <LeadingInitial text={leading.text} background={leading.background} color={leading.color} />
    default:
      return null
  }
}

function adaptSelectOptions(options: SpindleSelectOption[] | undefined): SearchableSelectOption[] {
  if (!options) return []
  return options.map((o) => ({
    value: o.value,
    label: o.label,
    sublabel: o.sublabel,
    group: o.group,
    disabled: o.disabled,
    leading: renderLeading(o.leading),
  }))
}

// ── Bridge components (one per mountable component) ───────────────────────

function TextInputBridge({ initial, bridge }: { initial: SpindleTextInputOptions; bridge: BridgeAPI<SpindleTextInputOptions, string> }) {
  const [props, setProps] = useState(initial)
  const [value, setValue] = useState(initial.value ?? '')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const commitValue = useBridgeBinding(bridge, props, setProps, value, setValue, 'value')
  useLayoutEffect(() => {
    bridge.focus = () => inputRef.current?.focus()
    bridge.blur = () => inputRef.current?.blur()
  }, [bridge])

  return (
    <TextInput
      value={value}
      onChange={(v) => {
        const committed = commitValue(v)
        notifyComponentOnChange('TextInput', props.onChange, committed)
      }}
      placeholder={props.placeholder}
      autoFocus={props.autoFocus}
      disabled={props.disabled}
      className={props.className}
      aria-label={props.ariaLabel}
      ref={inputRef}
    />
  )
}

function TextAreaBridge({ initial, bridge }: { initial: SpindleTextAreaOptions; bridge: BridgeAPI<SpindleTextAreaOptions, string> }) {
  const [props, setProps] = useState(initial)
  const [value, setValue] = useState(initial.value ?? '')
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const commitValue = useBridgeBinding(bridge, props, setProps, value, setValue, 'value')
  useLayoutEffect(() => {
    bridge.focus = () => taRef.current?.focus()
    bridge.blur = () => taRef.current?.blur()
  }, [bridge])

  return (
    <TextArea
      value={value}
      onChange={(v) => {
        const committed = commitValue(v)
        notifyComponentOnChange('TextArea', props.onChange, committed)
      }}
      placeholder={props.placeholder}
      rows={props.rows}
      disabled={props.disabled}
      className={props.className}
      aria-label={props.ariaLabel}
      ref={taRef}
    />
  )
}

function NumericInputBridge({ initial, bridge }: { initial: SpindleNumericInputOptions; bridge: BridgeAPI<SpindleNumericInputOptions, number | null> }) {
  const [props, setProps] = useState(initial)
  const [value, setValue] = useState<number | null>(initial.value ?? null)
  const commitValue = useBridgeBinding(bridge, props, setProps, value, setValue, 'value')
  return (
    <NumericInput
      value={value}
      onChange={(v) => {
        const committed = commitValue(v)
        notifyComponentOnChange('NumericInput', props.onChange, committed)
      }}
      allowEmpty={props.allowEmpty}
      integer={props.integer}
      min={props.min}
      max={props.max}
      step={props.step}
      placeholder={props.placeholder}
      disabled={props.disabled}
      className={clsx(formStyles.input, props.className)}
      aria-label={props.ariaLabel}
    />
  )
}

function NumberStepperBridge({ initial, bridge }: { initial: SpindleNumberStepperOptions; bridge: BridgeAPI<SpindleNumberStepperOptions, number | null> }) {
  const [props, setProps] = useState(initial)
  const [value, setValue] = useState<number | null>(initial.value ?? null)
  const commitValue = useBridgeBinding(bridge, props, setProps, value, setValue, 'value')
  return (
    <NumberStepper
      value={value}
      onChange={(v) => {
        const committed = commitValue(v)
        notifyComponentOnChange('NumberStepper', props.onChange, committed)
      }}
      min={props.min}
      max={props.max}
      step={props.step ?? 1}
      allowEmpty={props.allowEmpty}
      placeholder={props.placeholder}
      className={props.className}
    />
  )
}

function buildRangeSliderFormatter(
  format: SpindleRangeSliderFormat | undefined,
  step: number,
  integer: boolean,
): (val: number) => string {
  const decimals = format?.decimals ?? (integer ? 0 : (String(step).split('.')[1] || '').length)
  const prefix = format?.prefix ?? ''
  const suffix = format?.suffix ?? ''
  return (val) => {
    const num = decimals === 0 ? String(Math.round(val)) : val.toFixed(decimals)
    return `${prefix}${num}${suffix}`
  }
}

function RangeSliderBridge({ initial, bridge }: { initial: SpindleRangeSliderOptions; bridge: BridgeAPI<SpindleRangeSliderOptions, number> }) {
  const [props, setProps] = useState(initial)
  const [value, setValue] = useState<number>(initial.value ?? initial.min)
  const commitValue = useBridgeBinding(bridge, props, setProps, value, setValue, 'value')

  const handleCommit = (v: number) => {
    const committed = commitValue(v)
    props.onCommit?.(committed)
  }

  const handleDragValue = (v: number | null) => {
    props.onDragValue?.(v)
  }

  const sharedProps = {
    min: props.min,
    max: props.max,
    step: props.step,
    integer: props.integer,
    value,
    disabled: props.disabled,
    className: props.className,
    onCommit: handleCommit,
    onDragValue: handleDragValue,
  }

  if (props.label !== undefined) {
    const formatValue = buildRangeSliderFormatter(props.format, props.step ?? 1, props.integer ?? false)
    return (
      <LabeledRangeSlider
        label={props.label}
        hint={props.hint}
        formatValue={formatValue}
        {...sharedProps}
      />
    )
  }

  return <RangeSlider {...sharedProps} />
}

function CheckboxBridge({ initial, bridge }: { initial: SpindleCheckboxOptions; bridge: BridgeAPI<SpindleCheckboxOptions, boolean> }) {
  const [props, setProps] = useState(initial)
  const [checked, setChecked] = useState<boolean>(initial.checked ?? false)
  const commitValue = useBridgeBinding(bridge, props, setProps, checked, setChecked, 'checked')
  return (
    <Toggle.Checkbox
      checked={checked}
      onChange={(b) => {
        const committed = commitValue(b)
        notifyComponentOnChange('Checkbox', props.onChange, committed)
      }}
      label={props.label}
      hint={props.hint}
      disabled={props.disabled}
      className={props.className}
    />
  )
}

function SwitchBridge({ initial, bridge }: { initial: SpindleSwitchOptions; bridge: BridgeAPI<SpindleSwitchOptions, boolean> }) {
  const [props, setProps] = useState(initial)
  const [checked, setChecked] = useState<boolean>(initial.checked ?? false)
  const commitValue = useBridgeBinding(bridge, props, setProps, checked, setChecked, 'checked')
  return (
    <Toggle.Switch
      checked={checked}
      onChange={(b) => {
        const committed = commitValue(b)
        notifyComponentOnChange('Switch', props.onChange, committed)
      }}
      size={props.size}
      disabled={props.disabled}
      className={props.className}
    />
  )
}

function SelectBridge({ initial, bridge }: { initial: SpindleSelectOptions; bridge: BridgeAPI<SpindleSelectOptions, string> }) {
  const [props, setProps] = useState(initial)
  const [value, setValue] = useState<string>(initial.value ?? '')
  const commitValue = useBridgeBinding(bridge, props, setProps, value, setValue, 'value')
  return (
    <SearchableSelect
      value={value}
      onChange={(v) => {
        const committed = commitValue(v)
        notifyComponentOnChange('Select', props.onChange, committed)
      }}
      options={adaptSelectOptions(props.options)}
      placeholder={props.placeholder}
      searchPlaceholder={props.searchPlaceholder}
      searchThreshold={props.searchThreshold}
      emptyMessage={props.emptyMessage}
      noResultsMessage={props.noResultsMessage}
      triggerLabel={props.triggerLabel}
      triggerIcon={renderLeading(props.triggerIcon)}
      triggerClassName={props.triggerClassName}
      ariaLabel={props.ariaLabel}
      portal={props.portal ?? true}
      portalOwnerId={bridge.portalOwnerId}
      align={props.align}
      maxHeight={props.maxHeight}
      minWidth={props.minWidth}
      disabled={props.disabled}
      className={props.className}
      clearable={props.clearable}
      clearLabel={props.clearLabel}
    />
  )
}

function MultiSelectBridge({ initial, bridge }: { initial: SpindleMultiSelectOptions; bridge: BridgeAPI<SpindleMultiSelectOptions, string[]> }) {
  const [props, setProps] = useState(initial)
  const [value, setValue] = useState<string[]>(() => cloneBridgeValue(initial.value ?? []))
  const commitValue = useBridgeBinding(bridge, props, setProps, value, setValue, 'value')
  return (
    <SearchableSelect
      multi
      value={value}
      onChange={(v) => {
        const committed = commitValue(v)
        notifyComponentOnChange('MultiSelect', props.onChange, committed)
      }}
      options={adaptSelectOptions(props.options)}
      placeholder={props.placeholder}
      searchPlaceholder={props.searchPlaceholder}
      searchThreshold={props.searchThreshold}
      emptyMessage={props.emptyMessage}
      noResultsMessage={props.noResultsMessage}
      triggerLabel={props.triggerLabel}
      triggerIcon={renderLeading(props.triggerIcon)}
      triggerClassName={props.triggerClassName}
      ariaLabel={props.ariaLabel}
      portal={props.portal ?? true}
      portalOwnerId={bridge.portalOwnerId}
      align={props.align}
      maxHeight={props.maxHeight}
      minWidth={props.minWidth}
      disabled={props.disabled}
      className={props.className}
    />
  )
}

function ModelComboboxBridge({ initial, bridge }: { initial: SpindleModelComboboxOptions; bridge: BridgeAPI<SpindleModelComboboxOptions, string> }) {
  const [props, setProps] = useState(initial)
  const [value, setValue] = useState<string>(initial.value ?? '')
  const commitValue = useBridgeBinding(bridge, props, setProps, value, setValue, 'value')

  const bound = useConnectionModels(props.connection)
  const usingConnection = !!props.connection
  const models = usingConnection ? bound.models : (props.models ?? [])
  const modelLabels = usingConnection ? bound.modelLabels : (props.modelLabels ?? {})
  const loading = usingConnection ? bound.loading : !!props.loading
  const onRefresh = usingConnection ? bound.refresh : props.onRefresh

  useLayoutEffect(() => {
    bridge.refresh = () => onRefresh?.()
  }, [bridge, onRefresh])

  return (
    <ModelCombobox
      value={value}
      onChange={(v) => {
        const committed = commitValue(v)
        notifyComponentOnChange('ModelCombobox', props.onChange, committed)
      }}
      models={models}
      modelLabels={modelLabels}
      loading={loading}
      onRefresh={onRefresh}
      disabled={props.disabled}
      placeholder={props.placeholder}
      autoRefreshOnFocus={props.autoRefreshOnFocus}
      refreshKey={props.refreshKey}
      emptyMessage={props.emptyMessage}
      loadingMessage={props.loadingMessage}
      browseHint={props.browseHint}
      appearance={props.appearance ?? 'compact'}
    />
  )
}

function FolderDropdownBridge({ initial, bridge }: { initial: SpindleFolderDropdownOptions; bridge: BridgeAPI<SpindleFolderDropdownOptions, string> }) {
  const [props, setProps] = useState(initial)
  const [value, setValue] = useState<string>(initial.value ?? '')
  const commitValue = useBridgeBinding(bridge, props, setProps, value, setValue, 'value')
  return (
    <FolderDropdown
      folders={props.folders ?? []}
      selectedFolder={value}
      onSelect={(f) => {
        const committed = commitValue(f)
        notifyComponentOnChange('FolderDropdown', props.onChange, committed)
      }}
      onCreateFolder={(name) => props.onCreateFolder?.(name)}
      placeholder={props.placeholder}
      className={props.className}
    />
  )
}

function BadgeBridge({ initial, bridge }: { initial: SpindleBadgeOptions; bridge: BridgeAPI<SpindleBadgeOptions, string> }) {
  const [props, setProps] = useState(initial)
  useBridgeBinding(bridge, props, setProps, props.text ?? '', () => {}, undefined)
  return (
    <Badge color={props.color ?? 'neutral'} size={props.size ?? 'md'} className={props.className}>
      {props.text ?? ''}
    </Badge>
  )
}

function SpinnerBridge({ initial, bridge }: { initial: SpindleSpinnerOptions; bridge: BridgeAPI<SpindleSpinnerOptions, void> }) {
  const [props, setProps] = useState(initial)
  useBridgeBinding(bridge, props, setProps, undefined as void, () => {}, undefined)
  return <Spinner size={props.size} fast={props.fast} className={props.className} />
}

function CloseButtonBridge({ initial, bridge }: { initial: SpindleCloseButtonOptions; bridge: BridgeAPI<SpindleCloseButtonOptions, void> }) {
  const [props, setProps] = useState(initial)
  useBridgeBinding(bridge, props, setProps, undefined as void, () => {}, undefined)
  return (
    <CloseButton
      onClick={() => props.onClick?.()}
      size={props.size}
      variant={props.variant}
      position={props.position}
      iconSize={props.iconSize}
      className={props.className}
    />
  )
}

function PaginationBridge({ initial, bridge }: { initial: SpindlePaginationOptions; bridge: BridgeAPI<SpindlePaginationOptions, number> }) {
  const [props, setProps] = useState(initial)
  useBridgeBinding(bridge, props, setProps, props.currentPage, () => {}, undefined)
  return (
    <Pagination
      currentPage={props.currentPage}
      totalPages={props.totalPages}
      onPageChange={(p) => props.onPageChange(p)}
      perPage={props.perPage}
      perPageOptions={props.perPageOptions}
      onPerPageChange={(n) => props.onPerPageChange?.(n)}
      totalItems={props.totalItems}
    />
  )
}

function CollapsibleSectionBridge({
  initial,
  bridge,
  bodyEl,
}: {
  initial: SpindleCollapsibleSectionOptions
  bridge: BridgeAPI<SpindleCollapsibleSectionOptions, boolean>
  bodyEl: HTMLElement
}) {
  const [props, setProps] = useState(initial)
  const [expanded, setExpanded] = useState<boolean>(initial.defaultExpanded ?? true)
  useBridgeBinding(bridge, props, setProps, expanded, setExpanded, undefined)
  useLayoutEffect(() => {
    bridge.isExpanded = () => expanded
    bridge.open = () => setExpanded(true)
    bridge.close = () => setExpanded(false)
    bridge.body = bodyEl
  }, [bridge, expanded, bodyEl])

  // Compose icon from svg/url prop into ReactNode
  const icon: ReactElement | null = props.iconSvg
    ? <span dangerouslySetInnerHTML={{ __html: props.iconSvg }} />
    : props.iconUrl
      ? <img src={props.iconUrl} alt="" />
      : null

  return (
    <CollapsibleSection
      title={props.title}
      icon={icon}
      badge={props.badge}
      expanded={expanded}
      onToggle={(next) => { setExpanded(next); props.onToggle?.(next) }}
      className={props.className}
    >
      <Slot el={bodyEl} />
    </CollapsibleSection>
  )
}

function LoomBlockEditorBridge({
  initial,
  bridge,
  getMacroCatalogForExtension,
  extensionIdentifier,
}: {
  initial: NormalizedLoomOptions
  bridge: BridgeAPI<NormalizedLoomOptions, SpindleLoomBlockEditorValue>
  getMacroCatalogForExtension: () => Promise<unknown>
  extensionIdentifier: string
}) {
  const [props, setProps] = useState<NormalizedLoomOptions>(initial)
  const [valueState, setValueState] = useState<SpindleLoomBlockEditorValue>(initial.value)
  const [availableMacros, setAvailableMacros] = useState<MacroGroup[]>(() => getAvailableMacros())
  const propsRef = useRef(initial)
  const valueRef = useRef(initial.value)
  const aliveRef = useRef(true)
  const refreshTailRef = useRef<Promise<void>>(Promise.resolve())
  const refreshEpochRef = useRef(0)
  const refreshWaitersRef = useRef(new Set<{
    resolve(): void
    reject(error: unknown): void
  }>())

  const refreshMacros = useMemo(() => {
    return () => {
      if (!aliveRef.current) return Promise.reject(COMPONENT_DESTROYED_ERROR)
      const epoch = refreshEpochRef.current
      let resolvePromise!: () => void
      let rejectPromise!: (error: unknown) => void
      const promise = new Promise<void>((resolve, reject) => {
        resolvePromise = resolve
        rejectPromise = reject
      })
      const waiter = { resolve: resolvePromise, reject: rejectPromise }
      refreshWaitersRef.current.add(waiter)

      const request = refreshTailRef.current.then(async () => {
        if (!aliveRef.current || epoch !== refreshEpochRef.current) {
          throw COMPONENT_DESTROYED_ERROR
        }
        let groups: MacroGroup[]
        try {
          const raw = await getMacroCatalogForExtension()
          if (!aliveRef.current || epoch !== refreshEpochRef.current) {
            throw COMPONENT_DESTROYED_ERROR
          }
          groups = normalizeMacroCatalog(raw, extensionIdentifier)
        } catch (error) {
          if (!aliveRef.current || epoch !== refreshEpochRef.current) {
            throw COMPONENT_DESTROYED_ERROR
          }
          throw error
        }
        const apiCategories = new Set(groups.map((group) => group.category))
        setAvailableMacros([
          ...groups,
          ...getAvailableMacros().filter((group) => !apiCategories.has(group.category)),
        ])
      })
      refreshTailRef.current = request.catch(() => {})
      request.then(
        () => {
          if (!refreshWaitersRef.current.delete(waiter)) return
          waiter.resolve()
        },
        (error) => {
          if (!refreshWaitersRef.current.delete(waiter)) return
          waiter.reject(error)
        },
      )
      return promise
    }
  }, [getMacroCatalogForExtension, extensionIdentifier])

  const handleChange = (blocks: PromptBlock[]): boolean => {
    if (!aliveRef.current) return false
    const previousProps = propsRef.current
    const previousValue = valueRef.current
    let cloned: SpindleLoomBlockEditorValue
    try {
      const normalizedBlocks = normalizeCategoryBlockState(blocks)
      cloned = cloneLoomValue({
        blocks: normalizedBlocks,
        promptVariableValues: reconcilePromptVariableValues(
          previousValue.promptVariableValues,
          previousValue.blocks,
          normalizedBlocks,
        ),
      })
    } catch {
      return false
    }

    const nextProps = { ...previousProps, value: cloned }
    propsRef.current = nextProps
    valueRef.current = cloned
    setProps(nextProps)
    setValueState(cloned)

    notifyComponentOnChange('Loom', nextProps.onChange, cloneLoomValue(cloned))
    return true
  }

  useLayoutEffect(() => {
    bridge.update = (patch) => {
      const nextProps = patchLoomOptions(propsRef.current, patch)
      propsRef.current = nextProps
      valueRef.current = nextProps.value
      setProps(nextProps)
      setValueState(nextProps.value)
    }
    bridge.getValue = () => cloneLoomValue(valueRef.current)
    bridge.refreshMacros = refreshMacros
    bridge.invalidate = () => {
      if (!aliveRef.current) return
      aliveRef.current = false
      refreshEpochRef.current += 1
      for (const waiter of refreshWaitersRef.current) {
        waiter.reject(COMPONENT_DESTROYED_ERROR)
      }
      refreshWaitersRef.current.clear()
    }
  }, [bridge, refreshMacros])

  return (
    <ControlledLoomBlockEditor
      blocks={valueState.blocks as PromptBlock[]}
      promptVariables={valueState.promptVariableValues as PromptVariableValues}
      onChange={handleChange}
      availableMacros={availableMacros}
      refreshMacros={() => { void refreshMacros().catch(() => {}) }}
      readOnly={props.readOnly}
      compact={props.compact}
      trustedHostFeatures={false}
    />
  )
}

/** Renders a host-managed element into the React tree without React owning its children. */
function Slot({ el }: { el: HTMLElement }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const wrap = ref.current
    if (!wrap) return
    if (el.parentElement !== wrap) wrap.appendChild(el)
    return () => {
      if (el.parentElement === wrap) wrap.removeChild(el)
    }
  }, [el])
  return <div ref={ref} />
}

// ── Public factory ────────────────────────────────────────────────────────

export function createComponentsHelper(
  extensionId: string,
  identifier: string,
  getMacroCatalogForExtension: () => Promise<unknown>,
  generationOverride?: number,
): SpindleComponentsHelper {
  const generation = generationOverride ?? currentGeneration(extensionId)
  if (generationOverride !== undefined) extensionGenerations.set(extensionId, generationOverride)
  function mountText(target: SpindleComponentTarget, options?: SpindleTextInputOptions): SpindleTextInputHandle {
    const el = resolveTarget(extensionId, target, generation)
    const id = nextId(extensionId, 'text-input')
    const result = mountBridge<SpindleTextInputOptions, string>(el, (b) => (
      <TextInputBridge initial={options ?? {}} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result, componentPermissionForTarget(extensionId, el, generation)) as SpindleTextInputHandle
  }
  function mountTextArea(target: SpindleComponentTarget, options?: SpindleTextAreaOptions): SpindleTextAreaHandle {
    const el = resolveTarget(extensionId, target, generation)
    const id = nextId(extensionId, 'text-area')
    const result = mountBridge<SpindleTextAreaOptions, string>(el, (b) => (
      <TextAreaBridge initial={options ?? {}} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result, componentPermissionForTarget(extensionId, el, generation)) as SpindleTextAreaHandle
  }
  function mountNumericInput(target: SpindleComponentTarget, options?: SpindleNumericInputOptions): SpindleNumericInputHandle {
    const el = resolveTarget(extensionId, target, generation)
    const id = nextId(extensionId, 'numeric-input')
    const result = mountBridge<SpindleNumericInputOptions, number | null>(el, (b) => (
      <NumericInputBridge initial={options ?? {}} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result, componentPermissionForTarget(extensionId, el, generation)) as SpindleNumericInputHandle
  }
  function mountNumberStepper(target: SpindleComponentTarget, options?: SpindleNumberStepperOptions): SpindleNumberStepperHandle {
    const el = resolveTarget(extensionId, target, generation)
    const id = nextId(extensionId, 'number-stepper')
    const result = mountBridge<SpindleNumberStepperOptions, number | null>(el, (b) => (
      <NumberStepperBridge initial={options ?? {}} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result, componentPermissionForTarget(extensionId, el, generation)) as SpindleNumberStepperHandle
  }
  function mountRangeSlider(target: SpindleComponentTarget, options: SpindleRangeSliderOptions): SpindleRangeSliderHandle {
    const el = resolveTarget(extensionId, target, generation)
    const id = nextId(extensionId, 'range-slider')
    const result = mountBridge<SpindleRangeSliderOptions, number>(el, (b) => (
      <RangeSliderBridge initial={options} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result, componentPermissionForTarget(extensionId, el, generation)) as SpindleRangeSliderHandle
  }
  function mountCheckbox(target: SpindleComponentTarget, options?: SpindleCheckboxOptions): SpindleCheckboxHandle {
    const el = resolveTarget(extensionId, target, generation)
    const id = nextId(extensionId, 'checkbox')
    const result = mountBridge<SpindleCheckboxOptions, boolean>(el, (b) => (
      <CheckboxBridge initial={options ?? {}} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result, componentPermissionForTarget(extensionId, el, generation)) as SpindleCheckboxHandle
  }
  function mountSwitch(target: SpindleComponentTarget, options?: SpindleSwitchOptions): SpindleSwitchHandle {
    const el = resolveTarget(extensionId, target, generation)
    const id = nextId(extensionId, 'switch')
    const result = mountBridge<SpindleSwitchOptions, boolean>(el, (b) => (
      <SwitchBridge initial={options ?? {}} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result, componentPermissionForTarget(extensionId, el, generation)) as SpindleSwitchHandle
  }
  function mountSelect(target: SpindleComponentTarget, options: SpindleSelectOptions): SpindleSelectHandle {
    const el = resolveTarget(extensionId, target, generation)
    const id = nextId(extensionId, 'select')
    const result = mountBridge<SpindleSelectOptions, string>(el, (b) => (
      <SelectBridge initial={options} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result, componentPermissionForTarget(extensionId, el, generation)) as SpindleSelectHandle
  }
  function mountMultiSelect(target: SpindleComponentTarget, options: SpindleMultiSelectOptions): SpindleMultiSelectHandle {
    const el = resolveTarget(extensionId, target, generation)
    const id = nextId(extensionId, 'multi-select')
    const result = mountBridge<SpindleMultiSelectOptions, string[]>(el, (b) => (
      <MultiSelectBridge initial={options} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result, componentPermissionForTarget(extensionId, el, generation)) as SpindleMultiSelectHandle
  }
  function mountModelCombobox(target: SpindleComponentTarget, options: SpindleModelComboboxOptions): SpindleModelComboboxHandle {
    const el = resolveTarget(extensionId, target, generation)
    const id = nextId(extensionId, 'model-combobox')
    const result = mountBridge<SpindleModelComboboxOptions, string>(el, (b) => (
      <ModelComboboxBridge initial={options} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result, componentPermissionForTarget(extensionId, el, generation)) as SpindleModelComboboxHandle
  }
  function mountFolderDropdown(target: SpindleComponentTarget, options: SpindleFolderDropdownOptions): SpindleFolderDropdownHandle {
    const el = resolveTarget(extensionId, target, generation)
    const id = nextId(extensionId, 'folder-dropdown')
    const result = mountBridge<SpindleFolderDropdownOptions, string>(el, (b) => (
      <FolderDropdownBridge initial={options} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result, componentPermissionForTarget(extensionId, el, generation)) as SpindleFolderDropdownHandle
  }
  function mountBadge(target: SpindleComponentTarget, options: SpindleBadgeOptions): SpindleBadgeHandle {
    const el = resolveTarget(extensionId, target, generation)
    const id = nextId(extensionId, 'badge')
    const result = mountBridge<SpindleBadgeOptions, string>(el, (b) => (
      <BadgeBridge initial={options} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result, componentPermissionForTarget(extensionId, el, generation)) as SpindleBadgeHandle
  }
  function mountSpinner(target: SpindleComponentTarget, options?: SpindleSpinnerOptions): SpindleSpinnerHandle {
    const el = resolveTarget(extensionId, target, generation)
    const id = nextId(extensionId, 'spinner')
    const result = mountBridge<SpindleSpinnerOptions, void>(el, (b) => (
      <SpinnerBridge initial={options ?? {}} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result, componentPermissionForTarget(extensionId, el, generation)) as SpindleSpinnerHandle
  }
  function mountCollapsibleSection(target: SpindleComponentTarget, options: SpindleCollapsibleSectionOptions): SpindleCollapsibleSectionHandle {
    const el = resolveTarget(extensionId, target, generation)
    const id = nextId(extensionId, 'collapsible')
    const bodyEl = document.createElement('div')
    bodyEl.setAttribute('data-spindle-collapsible-body', id)
    const result = mountBridge<SpindleCollapsibleSectionOptions, boolean>(el, (b) => (
      <CollapsibleSectionBridge initial={options} bridge={b} bodyEl={bodyEl} />
    ))
    const base = buildHandle(extensionId, id, el, result, componentPermissionForTarget(extensionId, el, generation))
    const handle: SpindleCollapsibleSectionHandle = {
      componentId: base.componentId,
      element: base.element,
      update: base.update,
      destroy: base.destroy,
      body: bodyEl,
      isExpanded: () => base.isExpanded?.() ?? false,
      expand: () => base.open?.(),
      collapse: () => base.close?.(),
      toggle: () => {
        const expanded = base.isExpanded?.() ?? false
        if (expanded) base.close?.()
        else base.open?.()
      },
    }
    return handle
  }
  function mountPagination(target: SpindleComponentTarget, options: SpindlePaginationOptions): SpindlePaginationHandle {
    const el = resolveTarget(extensionId, target, generation)
    const id = nextId(extensionId, 'pagination')
    const result = mountBridge<SpindlePaginationOptions, number>(el, (b) => (
      <PaginationBridge initial={options} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result, componentPermissionForTarget(extensionId, el, generation)) as SpindlePaginationHandle
  }
  function mountCloseButton(target: SpindleComponentTarget, options?: SpindleCloseButtonOptions): SpindleCloseButtonHandle {
    const el = resolveTarget(extensionId, target, generation)
    const id = nextId(extensionId, 'close-button')
    const result = mountBridge<SpindleCloseButtonOptions, void>(el, (b) => (
      <CloseButtonBridge initial={options ?? {}} bridge={b} />
    ))
    return buildHandle(extensionId, id, el, result, componentPermissionForTarget(extensionId, el, generation)) as SpindleCloseButtonHandle
  }
  function mountLoomBlockEditor(target: SpindleComponentTarget, options: SpindleLoomBlockEditorOptions): SpindleLoomBlockEditorHandle {
    const normalized = cloneLoomOptions(options)
    const el = resolveTarget(extensionId, target, generation)
    const id = nextId(extensionId, 'loom-block-editor')
    const result = mountBridge<NormalizedLoomOptions, SpindleLoomBlockEditorValue>(el, (b) => (
      <LoomBlockEditorBridge
        initial={normalized}
        bridge={b}
        getMacroCatalogForExtension={getMacroCatalogForExtension}
        extensionIdentifier={identifier}
      />
    ))
    const handle = buildHandle(extensionId, id, el, result, componentPermissionForTarget(extensionId, el, generation)) as SpindleLoomBlockEditorHandle
    return handle
  }

  return {
    mountTextInput: mountText,
    mountTextArea,
    mountNumericInput,
    mountNumberStepper,
    mountRangeSlider,
    mountCheckbox,
    mountSwitch,
    mountSelect,
    mountMultiSelect,
    mountModelCombobox,
    mountFolderDropdown,
    mountBadge,
    mountSpinner,
    mountCollapsibleSection,
    mountPagination,
    mountCloseButton,
    mountLoomBlockEditor,
  }
}
