import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'

import LorebookHalfScreenEditor from '@/components/world-book-editor/LorebookHalfScreenEditor'
import ProductivitySettings from '@/components/settings/ProductivitySettings'
import { useStore } from '@/store'
import type { HostSurfaceJsonValue, HostSurfaceRenderContext } from './host-surface-registry'
import { QuickToolbar } from '@/components/quick-toolbar/QuickToolbar'
import { readQuickToolbarPlacement } from '@/components/quick-toolbar/quickToolbarDock'
import { effectiveQuickToolbarDockRequest } from '@/lib/chatSurfaceLayout'
import { ConnectionsPicker } from '@/components/connections-picker/ConnectionsPicker'
import LoreIndicator from '@/components/lore-indicator/LoreIndicator'
import PortraitDock from '@/components/chat/PortraitDock'
import LorebookEditorWorkspace from '@/components/world-book-editor/LorebookEditorWorkspace'
import { Waypoints } from 'lucide-react'
import inputStyles from '@/components/chat/InputArea.module.css'
import { ResizablePanelFrame } from '@/components/shared/ResizablePanelFrame'
import {
  DEFAULT_MIN_EDITOR_PANE_WIDTH,
  FULL_EDITOR_MIN,
  MOBILE_EDITOR_MAX_WIDTH,
  resolveWindowedEditorRect,
} from '@/lib/lorebookEditorGeometry'
import { getUiScale } from '@/lib/uiScale'
import { launchLorebookEditorThen } from '@/lib/lorebookLauncher'
import { setLorebookWorkspaceVisibility } from '@/lib/lorebookWorkspaceVisibility'
import modalStyles from '@/components/modals/WorldBookEditorModal.module.css'

export const PRODUCTIVITY_HOST_CONTRACT_VERSION = 1

export const CONNECTIONS_PICKER_CONTRACT_SURFACES = [
  'connections_picker.launcher',
  'connections_picker.panel',
] as const

export const PRODUCTIVITY_HOST_SURFACES = [
  'productivity.settings.workspace',
  'quick_toolbar.workspace',
  'connections_picker.launcher',
  'connections_picker.panel',
  'activated_lore.indicator',
  'activated_lore.panel',
  'portrait_dock.workspace',
  'lorebook.half.action',
  'lorebook.half.workspace',
  'lorebook.enhanced.action',
  'lorebook.enhanced.workspace',
] as const

export type ProductivityHostSurfaceId = typeof PRODUCTIVITY_HOST_SURFACES[number]

export type ProductivitySurfaceLifecycle = 'action' | 'workspace'

export interface ProductivitySurfaceNegotiation {
  readonly version: number
  readonly capabilities: readonly string[]
}

export interface ProductivitySurfaceCommand {
  readonly command: string
  readonly invocationId: string
  readonly ownerToken: string
  readonly generation: number
}

export interface LorebookWorkspaceState {
  readonly open: boolean
  readonly bookId: string | null
  readonly entryId: string | null
  readonly invocationId: string | null
  readonly source?: 'entry_table' | 'half_editor' | 'settings'
}

type ControllerOptions = {
  readonly surfaceId: ProductivityHostSurfaceId
  readonly ownerToken: string
  readonly generation: number
  readonly version: number
  readonly capabilities: readonly string[]
}

const LIFECYCLE_BY_SURFACE: Readonly<Record<ProductivityHostSurfaceId, ProductivitySurfaceLifecycle>> = {
  'productivity.settings.workspace': 'workspace',
  'quick_toolbar.workspace': 'workspace',
  'connections_picker.launcher': 'action',
  'connections_picker.panel': 'workspace',
  'activated_lore.indicator': 'action',
  'activated_lore.panel': 'workspace',
  'portrait_dock.workspace': 'workspace',
  'lorebook.half.action': 'action',
  'lorebook.half.workspace': 'workspace',
  'lorebook.enhanced.action': 'action',
  'lorebook.enhanced.workspace': 'workspace',
}

function stableCapabilities(capabilities: readonly string[]): readonly string[] {
  return [...new Set(capabilities.filter((capability) => capability.trim().length > 0))].sort()
}

/**
 * A renderer-local command authority. It rejects stale work before it reaches
 * a later host-action binding and gives each accepted command a correlation id.
 */
export class ProductivityHostSurfaceController {
  private readonly surfaceId: ProductivityHostSurfaceId
  private readonly ownerToken: string
  private readonly version: number
  private readonly capabilities: readonly string[]
  private generation: number
  private invocation = 0
  private destroyed = false

  constructor(options: ControllerOptions) {
    this.surfaceId = options.surfaceId
    this.ownerToken = options.ownerToken
    this.generation = options.generation
    this.version = options.version
    this.capabilities = stableCapabilities(options.capabilities)
  }

  get lifecycle(): ProductivitySurfaceLifecycle {
    return LIFECYCLE_BY_SURFACE[this.surfaceId]
  }

  negotiate(version: number, capabilities: readonly string[]): ProductivitySurfaceNegotiation | null {
    if (this.destroyed || version !== this.version) return null
    const requested = stableCapabilities(capabilities)
    if (requested.some((capability) => !this.capabilities.includes(capability))) return null
    return Object.freeze({ version: this.version, capabilities: requested })
  }

  advanceGeneration(generation: number): void {
    if (this.destroyed || generation <= this.generation) return
    this.generation = generation
  }

  invoke(command: string, generation: number, ownerToken: string): ProductivitySurfaceCommand | null {
    if (
      this.destroyed
      || generation !== this.generation
      || ownerToken !== this.ownerToken
      || !this.capabilities.includes(command)
    ) return null

    this.invocation += 1
    return Object.freeze({
      command,
      invocationId: `${this.surfaceId}:${this.generation}:${this.invocation}`,
      ownerToken: this.ownerToken,
      generation: this.generation,
    })
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
  }
}

function isSurfaceId(value: string): value is ProductivityHostSurfaceId {
  return (PRODUCTIVITY_HOST_SURFACES as readonly string[]).includes(value)
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function numberProp(props: Record<string, unknown>, key: string, fallback: number): number {
  const value = props[key]
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback
}

function stringProp(props: Record<string, unknown>, key: string): string {
  const value = props[key]
  return typeof value === 'string' ? value : ''
}

function syncCanonicalSettings(surfaceId: ProductivityHostSurfaceId, value: unknown): void {
  // Core owns the canonical Productivity rows and renders every host surface.
  // The suite receives only a projection of those rows; treating that projection
  // as a writer lets stale extension state overwrite direct UI edits.
  void surfaceId
  void value
}

function lorebookState(props: Record<string, unknown>): LorebookWorkspaceState {
  const value = props.state
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { open: false, bookId: null, entryId: null, invocationId: null }
  }
  const state = value as Record<string, unknown>
  return {
    open: state.open === true,
    bookId: typeof state.bookId === 'string' ? state.bookId : null,
    entryId: typeof state.entryId === 'string' ? state.entryId : null,
    invocationId: typeof state.invocationId === 'string' ? state.invocationId : null,
    source: state.source === 'half_editor' || state.source === 'settings' ? state.source : 'entry_table',
  }
}

function workspaceCloseCommand(
  props: Record<string, unknown>,
  state: LorebookWorkspaceState,
  generation: number,
): HostSurfaceJsonValue {
  return {
    command: 'close',
    generation,
    invocationId: state.invocationId ?? '',
    ownerToken: stringProp(props, 'ownerToken'),
  }
}

function viewportRect() {
  const scale = getUiScale() || 1
  return {
    x: 0,
    y: 0,
    width: Math.max(1, Math.floor((document.documentElement.clientWidth || window.innerWidth) / scale)),
    height: Math.max(1, Math.floor((document.documentElement.clientHeight || window.innerHeight) / scale)),
  }
}

function EnhancedLorebookWorkspaceSurface({
  props,
  state,
  generation,
  context,
}: {
  props: Record<string, unknown>
  state: LorebookWorkspaceState
  generation: number
  context: HostSurfaceRenderContext
}): ReactElement {
  const settings = useStore(store => store.lorebookEditorSettings)
  const setSetting = useStore(store => store.setSetting)
  const [viewport, setViewport] = useState(viewportRect)
  const [fullscreen, setFullscreen] = useState(() => (
    viewport.width <= MOBILE_EDITOR_MAX_WIDTH || settings.fullEditorLaunchMode === 'fullscreen'
  ))
  const backdropPointerDownRef = useRef<EventTarget | null>(null)
  const close = useCallback(
    () => context.emit('command', workspaceCloseCommand(props, state, generation)),
    [context, generation, props, state],
  )
  const [rect, setRect] = useState(() => resolveWindowedEditorRect(settings.fullRect, viewport))

  useEffect(() => {
    const resize = () => setViewport(viewportRect())
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  useEffect(() => {
    if (fullscreen) return
    setRect(resolveWindowedEditorRect(useStore.getState().lorebookEditorSettings.fullRect, viewport))
  }, [fullscreen, viewport])

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', handleEscape)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = previousOverflow
    }
  }, [close])

  const bounds = useMemo(() => ({
    minWidth: Math.min(
      Math.max(FULL_EDITOR_MIN.width, settings.minEditorPaneWidth ?? DEFAULT_MIN_EDITOR_PANE_WIDTH),
      viewport.width,
    ),
    minHeight: Math.min(FULL_EDITOR_MIN.height, viewport.height),
    maxWidth: viewport.width,
    maxHeight: viewport.height,
  }), [settings.minEditorPaneWidth, viewport])

  return (
    <div
      className={modalStyles.backdrop}
      style={{ zIndex: 10006 }}
      onPointerDown={(event) => {
        backdropPointerDownRef.current = event.target === event.currentTarget ? event.currentTarget : null
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && backdropPointerDownRef.current === event.currentTarget) close()
      }}
    >
      <ResizablePanelFrame
        rect={fullscreen ? viewport : rect}
        bounds={bounds}
        onCommit={(fullRect) => {
          if (fullscreen) return
          setRect(fullRect)
          if (viewport.width <= MOBILE_EDITOR_MAX_WIDTH) return
          setSetting('lorebookEditorSettings', {
            ...useStore.getState().lorebookEditorSettings,
            fullRect,
          })
        }}
        showHeader={false}
        resizable={!fullscreen}
        aria-label="Full-Screen Lorebook Editor"
        className={`${modalStyles.modal} ${fullscreen ? modalStyles.fullscreen : ''}`}
      >
        <LorebookEditorWorkspace
          variant="full"
          initialBookId={state.bookId}
          initialEntryId={state.entryId}
          onClose={close}
          fullscreen={fullscreen}
          onToggleFullscreen={() => setFullscreen((current) => {
            if (current) {
              setRect(resolveWindowedEditorRect(
                useStore.getState().lorebookEditorSettings.fullRect,
                viewport,
              ))
            }
            return !current
          })}
        />
      </ResizablePanelFrame>
    </div>
  )
}

function LorebookWorkspaceSurface({
  surfaceId,
  props,
  context,
}: {
  surfaceId: 'lorebook.half.workspace' | 'lorebook.enhanced.workspace'
  props: Record<string, unknown>
  context: HostSurfaceRenderContext
}): ReactElement {
  const state = lorebookState(props)
  const generation = numberProp(props, 'generation', 0)

  useEffect(() => {
    const visibilitySurface = surfaceId === 'lorebook.half.workspace' ? 'half' : 'enhanced'
    setLorebookWorkspaceVisibility(visibilitySurface, state.open)
    return () => setLorebookWorkspaceVisibility(visibilitySurface, false)
  }, [state.open, surfaceId])

  if (surfaceId === 'lorebook.enhanced.workspace') {
    if (!state.open) return null
    return <EnhancedLorebookWorkspaceSurface props={props} state={state} generation={generation} context={context} />
  }
  return (
    <LorebookHalfScreenEditor
      open={state.open}
      bookId={state.bookId}
      entryId={state.entryId}
      forceHalfScreen
      onClose={() => context.emit('command', workspaceCloseCommand(props, state, generation))}
      onOpenFullEditor={(bookId, entryId) => {
        if (!bookId) return
        launchLorebookEditorThen(
          { bookId, entryId, preferredTarget: 'full', source: 'half_editor' },
          () => context.emit('command', workspaceCloseCommand(props, state, generation)),
        )
      }}
    />
  )
}

export function ProductivityHostSurfaceRenderer({
  surfaceId,
  props,
  context,
}: {
  surfaceId: string
  props: Record<string, unknown>
  context: HostSurfaceRenderContext
}): ReactElement {
  if (!isSurfaceId(surfaceId)) throw new Error(`PRODUCTIVITY_SURFACE_UNKNOWN:${surfaceId}`)

  if (surfaceId === 'lorebook.half.workspace' || surfaceId === 'lorebook.enhanced.workspace') {
    return <LorebookWorkspaceSurface surfaceId={surfaceId} props={props} context={context} />
  }

  return <StandardProductivityHostSurface surfaceId={surfaceId} props={props} context={context} />
}

function StandardProductivityHostSurface({
  surfaceId,
  props,
  context,
}: {
  surfaceId: ProductivityHostSurfaceId
  props: Record<string, unknown>
  context: HostSurfaceRenderContext
}): ReactElement {

  const ownerToken = stringProp(props, 'ownerToken')
  const generation = numberProp(props, 'generation', 0)
  const version = numberProp(props, 'contractVersion', PRODUCTIVITY_HOST_CONTRACT_VERSION)
  const capabilities = stableCapabilities(stringList(props.capabilities))
  const controllerRef = useRef<ProductivityHostSurfaceController | null>(null)
  const identityRef = useRef<string | null>(null)
  const identity = `${surfaceId}:${ownerToken}:${version}:${capabilities.join(',')}`

  if (!controllerRef.current || identityRef.current !== identity) {
    const controller = new ProductivityHostSurfaceController({ surfaceId, ownerToken, generation, version, capabilities })
    controllerRef.current?.destroy()
    controllerRef.current = controller
    identityRef.current = identity
  }
  const controller = controllerRef.current
  controller.advanceGeneration(generation)

  useEffect(() => () => controller.destroy(), [controller])

  const state = props.state as Record<string, unknown> | undefined
  // Host bridges may recreate an equivalent state object on every render. Keep
  // canonical store synchronization semantic rather than identity-driven so
  // the indicator does not participate in a render/update loop while streaming.
  const stateKey = useMemo(() => JSON.stringify(state ?? null), [state])
  const stateRef = useRef(state)
  stateRef.current = state
  const surfaceRootRef = useRef<HTMLElement | null>(null)
  const [connectionsAnchor, setConnectionsAnchor] = useState<HTMLElement | null>(null)
  const quickToolbarSettings = useStore((store) => store.quickToolbarSettings)

  useLayoutEffect(() => {
    const root = surfaceRootRef.current?.closest<HTMLElement>(
      '[data-spindle-extension-root], [data-spindle-ext]',
    )
    if (!root) return
    const dockRequest = surfaceId === 'quick_toolbar.workspace'
      ? effectiveQuickToolbarDockRequest('strip', quickToolbarSettings)
      : surfaceId === 'activated_lore.indicator' ? 'strip' : null
    if (!dockRequest) return
    root.setAttribute('data-dock-request', dockRequest)
    return () => {
      if (root.getAttribute('data-dock-request') === dockRequest) root.removeAttribute('data-dock-request')
    }
  }, [quickToolbarSettings, surfaceId])

  useLayoutEffect(() => {
    if (surfaceId !== 'connections_picker.panel' || typeof document === 'undefined') return
    const anchor = document.querySelector<HTMLElement>('[data-lumiverse-connections-launcher]')
    if (anchor) setConnectionsAnchor(anchor)
  }, [surfaceId])

  const emitCommand = (command: string): void => {
    const invocation = controller.invoke(command, generation, ownerToken)
    if (!invocation) return
    context.emit('command', invocation as unknown as HostSurfaceJsonValue)
  }

  useEffect(() => {
    // Surface props are normally a projection of this same store. An
    // unconditional echo here marks initial defaults as a newer local edit
    // before async settings hydration and can also loop SETTINGS_UPDATED writes.
    syncCanonicalSettings(surfaceId, stateRef.current)
  }, [surfaceId, stateKey])
  let content: ReactElement
  switch (surfaceId) {
    case 'productivity.settings.workspace':
      content = <ProductivitySettings />
      break
    case 'quick_toolbar.workspace':
      content = readQuickToolbarPlacement(quickToolbarSettings) === 'chat_top_dock' ? <></> : <QuickToolbar />
      break
    case 'connections_picker.launcher':
      content = (
        <button
          type="button"
          className={inputStyles.actionBtn}
          data-lumiverse-connections-launcher="true"
          onClick={() => emitCommand('open')}
          title="Connections"
          aria-label="Connections"
        >
          <Waypoints size={14} />
        </button>
      )
      break
    case 'connections_picker.panel':
      content = <ConnectionsPicker open={state?.open !== false} onClose={() => emitCommand('close')} anchorElement={connectionsAnchor} />
      break
    case 'activated_lore.indicator':
      content = <LoreIndicator open={false} onOpenChange={(open) => { if (open) emitCommand('open') }} />
      break
    case 'activated_lore.panel':
      content = <LoreIndicator open onOpenChange={(open) => { if (!open) emitCommand('close') }} />
      break
    case 'portrait_dock.workspace':
      content = <PortraitDock mobile={state?.mobile === true} extensionOwned />
      break
    default:
      content = <section aria-label={surfaceId.replaceAll('_', ' ')} />
  }

  return (
    <section
      ref={surfaceRootRef}
      data-surface-id={surfaceId}
      data-contract-version={version}
      data-generation={generation}
      data-lifecycle={controller.lifecycle}
      aria-label={surfaceId.replaceAll('_', ' ')}
    >
      {content}
    </section>
  )
}
