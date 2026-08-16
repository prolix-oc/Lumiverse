import type {
  PortraitActiveState,
  PortraitDockMode,
  PortraitDockRect,
  PortraitDockSettings,
  PortraitPreviewRequest,
  PortraitViewModel,
} from './types'

export interface PortraitDockLayout {
  readonly width: number
  readonly height: number
  readonly viewportWidth: number
  readonly viewportHeight: number
  readonly chatRowWidth: number
  readonly chatRowHeight: number
  readonly chatColumnInnerMaxWidth: number
  readonly uiScale: number
}

export interface PortraitDockResizeOptions {
  readonly handles?: readonly string[]
  readonly bounds?: {
    readonly minWidth: number
    readonly minHeight: number
    readonly maxWidth?: number
    readonly maxHeight?: number
  }
  readonly aspectLock?: number
  readonly snap?: { readonly edges?: boolean; readonly threshold?: number }
  onChange?(rect: unknown): void
  onCommit?(rect: unknown): void
}

export interface PortraitDockHostContract {
  readonly state?: {
    get?(selector: string): unknown
    subscribe?(selector: string, handler: (value: unknown) => void): unknown
  }
  readonly characters?: {
    get?(characterId: string): unknown | Promise<unknown>
  }
  readonly character?: {
    get?(characterId: string): unknown | Promise<unknown>
  }
  readonly events?: {
    on?(event: string, handler: (payload: unknown) => void): unknown
  }
  readonly ui?: {
    mount?(point: string): unknown
    geometry?: {
      getUiScale?(): unknown
      toLayoutPx?(renderedPx: number): unknown
      layoutViewportSize?(): unknown
      layoutElementRect?(element: Element): unknown
      createResizeController?(element: HTMLElement, options: PortraitDockResizeOptions): unknown
    }
    registerHostIntentHandler?(name: string, handler: (detail: unknown) => boolean): unknown
    registerSettingsTab?(options: Record<string, unknown>): unknown
    events?: {
      on?(event: string, handler: (payload: unknown) => void): unknown
      get?(selector: string): unknown
      subscribe?(selector: string, handler: (value: unknown) => void): unknown
    }
  }
  readonly dom?: {
    inject?(target: string | Element, html: string, position?: string): unknown
    uninject?(element: unknown): void
  }
  getActiveChat?(): unknown
  getActive?(): unknown
}

export interface PortraitAvatarChanged {
  readonly chatId: string | null
  readonly characterId: string | null
  readonly imageId: string | null
}

export interface PortraitDockSurface {
  readonly root: HTMLElement
  destroy(): void
}

export interface PortraitDockHostAdapter {
  readActive(): PortraitActiveState
  subscribeActive(listener: (active: PortraitActiveState) => void): () => void
  subscribeAvatarChanged(listener: (change: PortraitAvatarChanged) => void): () => void
  readLayout(): PortraitDockLayout
  subscribeLayout(listener: (layout: PortraitDockLayout) => void): () => void
  resolvePortrait(active: PortraitActiveState): Promise<PortraitViewModel | null>
  createSurface(
    mode: PortraitDockMode,
    rect: PortraitDockRect,
    onCommit: (rect: PortraitDockRect) => void,
  ): PortraitDockSurface | undefined
  bindGeometry(
    root: HTMLElement,
    settings: PortraitDockSettings,
    onCommit: (rect: PortraitDockRect) => void,
  ): () => void
  registerPreview(handler: (request: PortraitPreviewRequest) => boolean): () => void
  registerSettings(render: (root: HTMLElement) => void | (() => void) | { destroy(): void }): () => void
}

type JsonRecord = Record<string, unknown>
type Dispose = () => void

const HANDLE_NAMES = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const
const DEFAULT_RECT: PortraitDockRect = { x: 32, y: 32, width: 320, height: 440 }
const DEFAULT_MIN_WIDTH = 180
const DEFAULT_MIN_HEIGHT = 220
const DEFAULT_MAX_WIDTH = 720
const DEFAULT_MAX_HEIGHT = 900
const noop: Dispose = () => undefined

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonNegative(value: unknown, fallback: number): number {
  const candidate = finite(value)
  return candidate === undefined ? fallback : Math.max(0, candidate)
}

function positive(value: unknown, fallback: number): number {
  const candidate = finite(value)
  return candidate === undefined || candidate <= 0 ? fallback : candidate
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const candidate = value.trim()
  return candidate.length > 0 && candidate.length <= 4096 ? candidate : undefined
}

function valueAt(source: JsonRecord | undefined, keys: readonly string[]): unknown {
  if (!source) return undefined
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key]
  }
  return undefined
}

function textAt(source: JsonRecord | undefined, keys: readonly string[]): string | undefined {
  return text(valueAt(source, keys))
}

function idAt(source: JsonRecord | undefined, keys: readonly string[]): string | null {
  return textAt(source, keys) ?? null
}

function unwrapRecord(value: unknown, keys: readonly string[]): JsonRecord | undefined {
  if (!isRecord(value)) return undefined
  for (const key of keys) {
    const nested = value[key]
    if (isRecord(nested)) return nested
  }
  return value
}

function normalizeActive(value: unknown): PortraitActiveState {
  const root = isRecord(value) && isRecord(value.active) ? value.active : value
  const record = isRecord(root) ? root : undefined
  const chat = isRecord(record?.chat) ? record.chat : undefined
  const character = isRecord(record?.character) ? record.character : undefined
  return {
    chatId: idAt(record, ['chatId', 'chat_id', 'activeChatId']) ?? idAt(chat, ['id', 'chatId', 'chat_id']),
    characterId: idAt(record, ['characterId', 'character_id', 'activeCharacterId']) ?? idAt(character, ['id', 'characterId', 'character_id']),
    avatarImageId: idAt(record, ['avatarImageId', 'avatar_image_id', 'activeChatAvatarId', 'activeAvatarImageId']),
  }
}
function normalizeAvatarChanged(value: unknown): PortraitAvatarChanged {
  const root = isRecord(value) && isRecord(value.data) ? value.data : value
  const record = isRecord(root) ? root : undefined
  return {
    chatId: idAt(record, ['chatId', 'chat_id']),
    characterId: idAt(record, ['characterId', 'character_id']),
    imageId: idAt(record, ['imageId', 'image_id']),
  }
}

function normalizedNumber(source: JsonRecord | undefined, keys: readonly string[], fallback: number): number {
  const candidate = finite(valueAt(source, keys))
  return candidate === undefined ? fallback : Math.max(0, candidate)
}

function normalizeLayout(value: unknown): PortraitDockLayout {
  const source = isRecord(value) && isRecord(value.layout) ? value.layout : isRecord(value) ? value : undefined
  const viewport = isRecord(source?.viewport) ? source.viewport : undefined
  const width = normalizedNumber(source, ['width', 'chatRowWidth', 'chat_row_width'], normalizedNumber(viewport, ['width'], 0))
  const height = normalizedNumber(source, ['height', 'chatRowHeight', 'chat_row_height'], normalizedNumber(viewport, ['height'], 0))
  const viewportWidth = normalizedNumber(source, ['viewportWidth', 'viewport_width'], width)
  const viewportHeight = normalizedNumber(source, ['viewportHeight', 'viewport_height'], height)
  const chatRowWidth = normalizedNumber(source, ['chatRowWidth', 'chat_row_width'], width)
  const chatRowHeight = normalizedNumber(source, ['chatRowHeight', 'chat_row_height'], height)
  return {
    width,
    height,
    viewportWidth,
    viewportHeight,
    chatRowWidth,
    chatRowHeight,
    chatColumnInnerMaxWidth: normalizedNumber(source, ['chatColumnInnerMaxWidth', 'chat_column_inner_max_width', 'maxWidth'], 0),
    uiScale: positive(valueAt(source, ['uiScale', 'ui_scale', 'scale']), 1),
  }
}

function normalizeRect(value: unknown, fallback: PortraitDockRect, bounds?: { minWidth: number; minHeight: number; maxWidth: number; maxHeight: number }): PortraitDockRect {
  const source = isRecord(value) ? value : undefined
  const minWidth = bounds?.minWidth ?? 0
  const minHeight = bounds?.minHeight ?? 0
  const maxWidth = Math.max(minWidth, bounds?.maxWidth ?? Number.POSITIVE_INFINITY)
  const maxHeight = Math.max(minHeight, bounds?.maxHeight ?? Number.POSITIVE_INFINITY)
  const x = finite(valueAt(source, ['x', 'left'])) ?? fallback.x
  const y = finite(valueAt(source, ['y', 'top'])) ?? fallback.y
  const width = Math.min(maxWidth, Math.max(minWidth, finite(valueAt(source, ['width', 'w'])) ?? fallback.width))
  const height = Math.min(maxHeight, Math.max(minHeight, finite(valueAt(source, ['height', 'h'])) ?? fallback.height))
  return { x: Number.isFinite(x) ? x : fallback.x, y: Number.isFinite(y) ? y : fallback.y, width, height }
}

function normalizePreview(value: unknown): PortraitPreviewRequest | null {
  if (!isRecord(value)) return null
  const imageUrl = textAt(value, ['imageUrl', 'image_url'])
  if (!imageUrl) return null
  const caption = textAt(value, ['caption', 'alt', 'name'])
  const source = textAt(value, ['source'])
  return {
    imageUrl,
    ...(caption ? { caption } : {}),
    ...(source ? { source } : {}),
  }
}

function normalizeMode(value: unknown): PortraitDockMode {
  return value === 'side-left' || value === 'side-right' || value === 'floating' ? value : 'floating'
}

function isElementLike(value: unknown): value is HTMLElement {
  if (!value || typeof value !== 'object') return false
  const candidate = value as JsonRecord
  return candidate.nodeType === 1
    || typeof candidate.appendChild === 'function'
    || typeof candidate.append === 'function'
}

function elementFrom(value: unknown): HTMLElement | undefined {
  if (isRecord(value) && ('root' in value || 'element' in value)) {
    return elementFrom(value.root ?? value.element)
  }
  return isElementLike(value) ? value : undefined
}

function documentLike(value: unknown): value is Document {
  return isRecord(value) && typeof value.createElement === 'function'
}

function documentFor(_ctx: PortraitDockHostContract, owner?: HTMLElement): Document | undefined {
  const ownerDocument = owner?.ownerDocument
  return documentLike(ownerDocument) ? ownerDocument : undefined
}

function attribute(element: HTMLElement, name: string): string | undefined {
  try {
    const value = element.getAttribute?.(name)
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

function setAttribute(element: HTMLElement, name: string, value: string): void {
  try {
    element.setAttribute?.(name, value)
  } catch {
    // A host test double may expose only append/remove; attributes are optional.
  }
}

function append(parent: HTMLElement, child: HTMLElement): boolean {
  try {
    if (typeof parent.append === 'function') {
      parent.append(child)
      return true
    }
    if (typeof parent.appendChild === 'function') {
      parent.appendChild(child)
      return true
    }
  } catch {
    return false
  }
  return false
}

function remove(element: HTMLElement | undefined): void {
  try {
    element?.remove?.()
  } catch {
    // The owning host is allowed to retire a root before teardown.
  }
}

function once(action: () => void): Dispose {
  let active = true
  return () => {
    if (!active) return
    active = false
    try {
      action()
    } catch {
      // Teardown must not be made non-idempotent by a host callback.
    }
  }
}

function disposer(value: unknown): Dispose {
  if (typeof value === 'function') return once(value as () => void)
  if (!isRecord(value)) return noop
  if (typeof value.destroy === 'function') return once(() => { (value.destroy as () => void)() })
  if (typeof value.dispose === 'function') return once(() => { (value.dispose as () => void)() })
  if (typeof value.unsubscribe === 'function') return once(() => { (value.unsubscribe as () => void)() })
  return noop
}

function destroyHandle(value: unknown): void {
  disposer(value)()
}

function readSelector(ctx: PortraitDockHostContract, selector: string): unknown {
  try {
    const value = ctx.state?.get?.(selector)
    if (value !== undefined) return value
  } catch {
    // Fall through to the legacy event/read surfaces.
  }
  try {
    const eventValue = ctx.ui?.events?.get?.(selector)
    if (eventValue !== undefined) return eventValue
  } catch {
    // Optional compatibility surface.
  }
  return undefined
}

function subscribeSelector(ctx: PortraitDockHostContract, selector: string, handler: (value: unknown) => void): Dispose {
  let active = true
  const wrapped = (value: unknown) => {
    if (!active) return
    try { handler(value) } catch { /* isolate extension listeners */ }
  }
  let subscription: unknown
  try {
    subscription = ctx.state?.subscribe?.(selector, wrapped)
    if (subscription !== undefined) {
      const stop = disposer(subscription)
      return once(() => { active = false; stop() })
    }
  } catch {
    // Fall through to the optional UI event bridge.
  }
  try {
    subscription = ctx.ui?.events?.subscribe?.(selector, wrapped)
    if (subscription !== undefined) {
      const stop = disposer(subscription)
      return once(() => { active = false; stop() })
    }
  } catch {
    // Optional compatibility surface.
  }
  active = false
  return noop
}
function subscribeEvent(ctx: PortraitDockHostContract, event: string, handler: (payload: unknown) => void): Dispose {
  let active = true
  const wrapped = (payload: unknown) => {
    if (!active) return
    try { handler(payload) } catch { /* isolate extension listeners */ }
  }
  const sources = [ctx.events, ctx.ui?.events]
  for (const source of sources) {
    const register = source?.on
    if (typeof register !== 'function') continue
    try {
      const subscription = register.call(source, event, wrapped)
      if (subscription === undefined) continue
      const stop = disposer(subscription)
      return once(() => { active = false; stop() })
    } catch {
      // Try the next optional event surface.
    }
  }
  active = false
  return noop
}


function imageUrl(imageId: string): string {
  return `/api/v1/images/${encodeURIComponent(imageId)}`
}

function characterRecord(value: unknown): JsonRecord | undefined {
  const direct = unwrapRecord(value, ['character'])
  if (!direct) return undefined
  if (isRecord(direct.data)) {
    if (isRecord(direct.data.character)) return direct.data.character
    if (isRecord(direct.data)) return direct.data
  }
  return direct
}

function sourceImage(character: JsonRecord, active: PortraitActiveState): { id: string; source: string } | null {
  if (active.avatarImageId) {
    const extensions = isRecord(character.extensions) ? character.extensions : undefined
    const alternates = Array.isArray(extensions?.alternate_avatars)
      ? extensions.alternate_avatars
      : Array.isArray(character.alternate_avatars)
        ? character.alternate_avatars
        : []
    for (const value of alternates) {
      if (!isRecord(value)) continue
      if (textAt(value, ['image_id', 'imageId']) !== active.avatarImageId) continue
      const original = textAt(value, ['original_image_id', 'originalImageId'])
      if (original) return { id: original, source: 'alternate-original' }
    }
    return { id: active.avatarImageId, source: 'avatar-override' }
  }
  const extensions = isRecord(character.extensions) ? character.extensions : undefined
  const original = textAt(character, ['original_image_id', 'originalImageId'])
    ?? textAt(extensions, ['original_image_id', 'originalImageId'])
  if (original) return { id: original, source: 'character-original' }
  const imageId = textAt(character, ['image_id', 'imageId'])
  return imageId ? { id: imageId, source: 'character-image' } : null
}

function viewportWidth(ctx: PortraitDockHostContract): number {
  const layout = normalizeLayout(readSelector(ctx, 'ui.layout'))
  if (layout.viewportWidth > 0) return layout.viewportWidth
  try {
    const viewport = ctx.ui?.geometry?.layoutViewportSize?.()
    const width = finite(isRecord(viewport) ? valueAt(viewport, ['width', 'viewportWidth']) : undefined)
    if (width !== undefined && width > 0) return width
  } catch {
    // H6 geometry is optional on older hosts.
  }
  return 0
}

const CHAT_GAP = -20
const DEFAULT_SNAP_THRESHOLD = 12

interface LayoutBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface ResizeObserverLike {
  observe(target: Element): void
  disconnect(): void
}

type ResizeObserverConstructorLike = new (callback: () => void) => ResizeObserverLike

function layoutBox(value: unknown): LayoutBox | undefined {
  if (!isRecord(value)) return undefined
  const width = finite(valueAt(value, ['width', 'w']))
  const height = finite(valueAt(value, ['height', 'h']))
  if (width === undefined || height === undefined) return undefined
  return {
    x: finite(valueAt(value, ['x', 'left'])) ?? 0,
    y: finite(valueAt(value, ['y', 'top'])) ?? 0,
    width: Math.max(0, width),
    height: Math.max(0, height),
  }
}

export function getPortraitLayoutReclaim(
  bodyWidth: number,
  chatContentWidth: number,
  portraitWidth: number,
): number {
  const contentWidth = Math.min(bodyWidth, chatContentWidth)
  const naturalGutter = Math.max(0, (bodyWidth - contentWidth) / 2)
  const reservedWidth = Math.min(
    portraitWidth,
    Math.max(0, 2 * (portraitWidth + CHAT_GAP - naturalGutter)),
  )
  return Math.max(0, portraitWidth - reservedWidth)
}

function layoutViewport(
  ctx: PortraitDockHostContract,
  geometry: NonNullable<NonNullable<PortraitDockHostContract['ui']>['geometry']>,
): { width: number; height: number } | undefined {
  let raw: unknown
  try { raw = geometry.layoutViewportSize?.() } catch { raw = undefined }
  const measured = normalizeLayout(raw)
  if (measured.viewportWidth > 0 && measured.viewportHeight > 0) {
    return { width: measured.viewportWidth, height: measured.viewportHeight }
  }
  const fallback = normalizeLayout(readSelector(ctx, 'ui.layout'))
  if (fallback.viewportWidth > 0 && fallback.viewportHeight > 0) {
    return { width: fallback.viewportWidth, height: fallback.viewportHeight }
  }
  return undefined
}

function toLayoutPx(
  geometry: NonNullable<NonNullable<PortraitDockHostContract['ui']>['geometry']>,
  renderedPx: number,
): number {
  try {
    const converted = finite(geometry.toLayoutPx?.(renderedPx))
    if (converted !== undefined) return converted
  } catch {
    // Fall through to the scale fallback for older host geometry adapters.
  }
  let scale = 1
  try { scale = positive(geometry.getUiScale?.(), 1) } catch { scale = 1 }
  return renderedPx / scale
}

function layoutElementRect(
  geometry: NonNullable<NonNullable<PortraitDockHostContract['ui']>['geometry']>,
  element: Element,
): LayoutBox | undefined {
  try { return layoutBox(geometry.layoutElementRect?.(element)) } catch { return undefined }
}

function eventElement(value: EventTarget | null): Element | undefined {
  return value instanceof Element ? value : undefined
}

function hasClass(element: Element, name: string): boolean {
  const classes = attribute(element as HTMLElement, 'class')
  return classes?.split(/\s+/).includes(name) ?? false
}

function isInteractiveDragTarget(target: EventTarget | null, header: Element): boolean {
  let current = eventElement(target)
  if (!current || !header.contains(current)) return true
  while (current && current !== header) {
    const tag = current.tagName?.toLowerCase()
    if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea') return true
    if (attribute(current as HTMLElement, 'data-portrait-action') !== undefined) return true
    if (attribute(current as HTMLElement, 'data-resize-handle') !== undefined) return true
    if (attribute(current as HTMLElement, 'role') === 'button') return true
    if (hasClass(current, 'portrait-dock__controls') || hasClass(current, 'portrait-dock__control')) return true
    current = current.parentElement ?? undefined
  }
  return false
}

function setFloatingPosition(root: HTMLElement, x: number, y: number): void {
  try {
    root.style.left = `${x}px`
    root.style.top = `${y}px`
    root.style.setProperty('--portrait-dock-left', `${x}px`)
    root.style.setProperty('--portrait-dock-top', `${y}px`)
    root.style.setProperty('--portrait-dock-x', `${x}px`)
    root.style.setProperty('--portrait-dock-y', `${y}px`)
  } catch {
    // A host test double may expose only the DOM tree.
  }
}

function sideLayoutElements(root: HTMLElement): { body: HTMLElement; chatInner: HTMLElement } | undefined {
  const mount = root.parentElement
  let body = mount?.parentElement
  if (!body) {
    try { body = root.closest?.('[data-chat-constrained]') as HTMLElement | null ?? undefined } catch { body = undefined }
  }
  if (!body || attribute(body, 'data-chat-constrained') === undefined) return undefined

  let chatInner: HTMLElement | undefined
  try {
    const candidate = body.querySelector?.('[data-chat-column-inner], [class*="chatColumnInner"], [class*="chat-column-inner"]') ?? undefined
    chatInner = elementFrom(candidate)
  } catch {
    chatInner = undefined
  }
  if (!chatInner) {
    try {
      for (const child of Array.from(body.children ?? [])) {
        if (child === mount) continue
        const nested = child.querySelector?.('[data-component="MessageList"], [data-component="InputArea"]')
        const candidate = nested?.parentElement ?? child.lastElementChild ?? undefined
        const element = elementFrom(candidate)
        if (element) {
          chatInner = element
          break
        }
      }
    } catch {
      chatInner = undefined
    }
  }
  return chatInner ? { body, chatInner } : undefined
}


export function createPortraitDockHostAdapter(ctx: PortraitDockHostContract): PortraitDockHostAdapter {
  const readActive = (): PortraitActiveState => {
    let raw = readSelector(ctx, 'chat.active')
    if (raw === undefined) {
      try { raw = ctx.getActiveChat?.() } catch { raw = undefined }
    }
    if (raw === undefined) {
      try { raw = ctx.getActive?.() } catch { raw = undefined }
    }
    return normalizeActive(raw)
  }

  const readLayout = (): PortraitDockLayout => {
    const raw = readSelector(ctx, 'ui.layout')
    if (raw !== undefined) return normalizeLayout(raw)
    try {
      return normalizeLayout(ctx.ui?.geometry?.layoutViewportSize?.())
    } catch {
      return normalizeLayout(undefined)
    }
  }

  return {
    readActive,

    subscribeActive(listener) {
      return subscribeSelector(ctx, 'chat.active', value => listener(normalizeActive(value)))
    },
    subscribeAvatarChanged(listener) {
      return subscribeEvent(ctx, 'CHARACTER_AVATAR_CHANGED', value => listener(normalizeAvatarChanged(value)))
    },

    readLayout,

    subscribeLayout(listener) {
      return subscribeSelector(ctx, 'ui.layout', value => listener(normalizeLayout(value)))
    },

    async resolvePortrait(active) {
      const normalized = normalizeActive(active)
      if (!normalized.chatId || !normalized.characterId) return null
      const getter = ctx.characters?.get ?? ctx.character?.get
      if (typeof getter !== 'function') return null
      let raw: unknown
      try {
        raw = await getter.call(ctx.characters ?? ctx.character, normalized.characterId)
      } catch {
        return null
      }
      const character = characterRecord(raw)
      if (!character) return null
      const selected = sourceImage(character, normalized)
      if (!selected) return null
      const name = textAt(character, ['name', 'display_name', 'displayName', 'character_name']) ?? normalized.characterId
      return {
        chatId: normalized.chatId,
        characterId: normalized.characterId,
        name,
        imageUrl: imageUrl(selected.id),
        source: selected.source,
      }
    },

    createSurface(mode, _rect, _onCommit) {
      const normalizedMode = normalizeMode(mode)
      const useBody = normalizedMode === 'floating' || viewportWidth(ctx) <= 720
      if (useBody) {
        const dom = ctx.dom
        if (typeof dom?.inject !== 'function') return undefined
        const html = `<section data-lumiverse-module="portrait_dock" data-mode="${normalizedMode}"></section>`
        let tracker: unknown
        try {
          tracker = dom.inject('body', html)
        } catch {
          return undefined
        }
        const injected = elementFrom(tracker)
        if (!injected) {
          try { dom.uninject?.(tracker) } catch { /* best effort */ }
          return undefined
        }
        let root = injected
        if (attribute(injected, 'data-lumiverse-module') !== 'portrait_dock') {
          try {
            const nested = injected.querySelector?.('[data-lumiverse-module="portrait_dock"]')
            root = elementFrom(nested) ?? injected
          } catch {
            root = injected
          }
        }
        setAttribute(root, 'data-lumiverse-module', 'portrait_dock')
        setAttribute(root, 'data-mode', normalizedMode)
        return {
          root,
          destroy: once(() => {
            if (typeof dom.uninject === 'function') {
              try {
                dom.uninject(tracker)
                return
              } catch {
                // A stale injection may already have been retired.
              }
            }
            remove(elementFrom(tracker) ?? root)
          }),
        }
      }

      let mount: HTMLElement | undefined
      try { mount = elementFrom(ctx.ui?.mount?.('chat_surface_side')) } catch { mount = undefined }
      if (!mount) return undefined
      const document = documentFor(ctx, mount)
      if (!document) return undefined
      let root: HTMLElement
      try { root = document.createElement('section') } catch { return undefined }
      const previousDisplay = mount.style?.display ?? ''
      try { mount.style.display = 'contents' } catch { /* Host test doubles may omit style. */ }
      setAttribute(root, 'data-lumiverse-module', 'portrait_dock')
      setAttribute(root, 'data-mode', normalizedMode)
      if (!append(mount, root)) {
        try {
          if (previousDisplay) mount.style.display = previousDisplay
          else mount.style.removeProperty('display')
        } catch { /* Best effort restoration. */ }
        return undefined
      }
      return {
        root,
        destroy: once(() => {
          remove(root)
          try {
            if (previousDisplay) mount.style.display = previousDisplay
            else mount.style.removeProperty('display')
          } catch { /* The host may have retired the mount wrapper. */ }
        }),
      }
    },

    bindGeometry(root, settings, onCommit) {
      const geometry = ctx.ui?.geometry
      if (!root || typeof geometry?.createResizeController !== 'function') return noop
      let nodes: Element[] = []
      try { nodes = Array.from(root.querySelectorAll?.('[data-resize-handle]') ?? []) } catch { nodes = [] }
      const present = new Set<string>()
      for (const node of nodes) {
        const name = attribute(node as HTMLElement, 'data-resize-handle')
        if (name && (HANDLE_NAMES as readonly string[]).includes(name)) present.add(name)
      }
      if (present.size !== HANDLE_NAMES.length) return noop

      const source = isRecord(settings) ? settings : undefined
      const minWidth = nonNegative(valueAt(source, ['minWidth', 'min_width']), DEFAULT_MIN_WIDTH)
      const minHeight = nonNegative(valueAt(source, ['minHeight', 'min_height']), DEFAULT_MIN_HEIGHT)
      const maxWidth = Math.max(minWidth, nonNegative(valueAt(source, ['maxWidth', 'max_width']), DEFAULT_MAX_WIDTH))
      const maxHeight = Math.max(minHeight, nonNegative(valueAt(source, ['maxHeight', 'max_height']), DEFAULT_MAX_HEIGHT))
      const fallbackRect = normalizeRect(valueAt(source, ['rect']), DEFAULT_RECT, { minWidth, minHeight, maxWidth, maxHeight })
      let currentRect = fallbackRect
      const aspectRatio = source?.aspectRatioLocked === true && fallbackRect.height > 0
        ? fallbackRect.width / fallbackRect.height
        : undefined
      const snapThreshold = nonNegative(valueAt(source, ['snapThreshold', 'snap_threshold']), DEFAULT_SNAP_THRESHOLD)
      const mode = normalizeMode(attribute(root, 'data-mode') ?? valueAt(source, ['mode']))
      const cleanup: Dispose[] = []

      const viewport = (): { width: number; height: number } | undefined => layoutViewport(ctx, geometry)
      const clampPosition = (rect: PortraitDockRect): PortraitDockRect => {
        const currentViewport = viewport()
        if (!currentViewport) return rect
        const maxX = Math.max(0, currentViewport.width - rect.width)
        const maxY = Math.max(0, currentViewport.height - rect.height)
        let x = Math.max(0, Math.min(maxX, rect.x))
        let y = Math.max(0, Math.min(maxY, rect.y))
        if (source?.snapToEdge === true) {
          if (x <= snapThreshold) x = 0
          else if (maxX - x <= snapThreshold) x = maxX
          if (y <= snapThreshold) y = 0
          else if (maxY - y <= snapThreshold) y = maxY
        }
        return { ...rect, x, y }
      }

      const applyFloatingRect = (rect: PortraitDockRect): void => {
        if (mode !== 'floating') return
        setFloatingPosition(root, rect.x, rect.y)
        try {
          root.style.width = `${rect.width}px`
          root.style.height = `${rect.height}px`
          root.style.setProperty('--portrait-dock-width', `${rect.width}px`)
          root.style.setProperty('--portrait-dock-height', `${rect.height}px`)
        } catch {
          // A host test double may expose only the DOM tree.
        }
      }

      for (const handle of HANDLE_NAMES) {
        try {
          const controller = geometry.createResizeController(root, {
            handles: [handle],
            bounds: { minWidth, minHeight, maxWidth, maxHeight },
            ...(aspectRatio !== undefined ? { aspectLock: aspectRatio } : {}),
            snap: { edges: source?.snapToEdge === true, threshold: snapThreshold },
            onChange: value => {
              const next = clampPosition(normalizeRect(value, currentRect, { minWidth, minHeight, maxWidth, maxHeight }))
              currentRect = next
              applyFloatingRect(next)
            },
            onCommit: value => {
              const next = clampPosition(normalizeRect(value, currentRect, { minWidth, minHeight, maxWidth, maxHeight }))
              currentRect = next
              try { onCommit(next) } catch { /* isolate extension persistence */ }
            },
          })
          cleanup.push(disposer(controller))
        } catch {
          for (const dispose of cleanup.splice(0).reverse()) dispose()
          return noop
        }
      }
      applyFloatingRect(currentRect)

      const ownerDocument = documentFor(ctx, root)
      const header = (() => {
        try { return elementFrom(root.querySelector?.('.portrait-dock__header')) } catch { return undefined }
      })()
      let dragging = false
      let activePointerId: number | undefined
      let startLayoutX = 0
      let startLayoutY = 0
      let dragStartRect = currentRect
      let dragRect = currentRect

      const removePointerListeners = (): void => {
        if (!ownerDocument) return
        try {
          ownerDocument.removeEventListener('pointermove', onPointerMove)
          ownerDocument.removeEventListener('pointerup', onPointerUp)
          ownerDocument.removeEventListener('pointercancel', onPointerCancel)
        } catch { /* Teardown must tolerate a retired document. */ }
      }
      const finishDrag = (commit: boolean): void => {
        if (!dragging) return
        dragging = false
        activePointerId = undefined
        removePointerListeners()
        if (!commit) return
        currentRect = dragRect
        try { onCommit(dragRect) } catch { /* isolate extension persistence */ }
      }
      const onPointerMove = (rawEvent: Event): void => {
        if (!dragging) return
        const event = rawEvent as PointerEvent
        const pointerId = finite(event.pointerId)
        if (activePointerId !== undefined && pointerId !== undefined && pointerId !== activePointerId) return
        const { clientX: renderedX, clientY: renderedY } = event
        const clientX = finite(renderedX)
        const clientY = finite(renderedY)
        if (clientX === undefined || clientY === undefined) return
        const layoutX = toLayoutPx(geometry, clientX)
        const layoutY = toLayoutPx(geometry, clientY)
        dragRect = clampPosition({
          ...dragStartRect,
          x: dragStartRect.x + layoutX - startLayoutX,
          y: dragStartRect.y + layoutY - startLayoutY,
        })
        setFloatingPosition(root, dragRect.x, dragRect.y)
      }
      const onPointerUp = (): void => finishDrag(true)
      const onPointerCancel = (): void => finishDrag(true)
      const onPointerDown = (rawEvent: Event): void => {
        if (mode !== 'floating' || !header || isInteractiveDragTarget(rawEvent.target, header)) return
        const event = rawEvent as PointerEvent
        const { clientX: renderedX, clientY: renderedY } = event
        const clientX = finite(renderedX)
        const clientY = finite(renderedY)
        if (clientX === undefined || clientY === undefined || !ownerDocument) return
        const layoutX = toLayoutPx(geometry, clientX)
        const layoutY = toLayoutPx(geometry, clientY)
        dragging = true
        activePointerId = finite(event.pointerId)
        startLayoutX = layoutX
        startLayoutY = layoutY
        dragStartRect = currentRect
        dragRect = currentRect
        try { event.preventDefault?.() } catch { /* Optional on host event doubles. */ }
        try {
          ownerDocument.addEventListener('pointermove', onPointerMove)
          ownerDocument.addEventListener('pointerup', onPointerUp)
          ownerDocument.addEventListener('pointercancel', onPointerCancel)
        } catch {
          dragging = false
          activePointerId = undefined
          removePointerListeners()
        }
      }
      if (header) {
        try { header.addEventListener('pointerdown', onPointerDown) } catch { /* Optional in host test doubles. */ }
        cleanup.push(once(() => {
          finishDrag(false)
          try { header.removeEventListener('pointerdown', onPointerDown) } catch { /* Best effort. */ }
        }))
      }

      const sideLayout = mode === 'floating' ? undefined : sideLayoutElements(root)
      const reclaimProperty = '--portrait-dock-layout-reclaim'
      const previousReclaim = root.style?.getPropertyValue(reclaimProperty) ?? ''
      const applyReclaim = (): void => {
        let reclaim = 0
        if (sideLayout) {
          const bodyRect = layoutElementRect(geometry, sideLayout.body)
          const chatRect = layoutElementRect(geometry, sideLayout.chatInner)
          const portraitRect = layoutElementRect(geometry, root)
          const portraitWidth = portraitRect?.width ?? currentRect.width
          if (bodyRect && chatRect && Number.isFinite(portraitWidth)) {
            reclaim = Math.round(getPortraitLayoutReclaim(bodyRect.width, chatRect.width, portraitWidth))
          }
        }
        try { root.style.setProperty(reclaimProperty, `${Math.max(0, reclaim)}px`) } catch { /* Optional style surface. */ }
      }
      if (sideLayout) {
        cleanup.push(subscribeSelector(ctx, 'ui.layout', () => applyReclaim()))
      }
      applyReclaim()
      cleanup.push(once(() => {
        try {
          if (previousReclaim) root.style.setProperty(reclaimProperty, previousReclaim)
          else root.style.removeProperty(reclaimProperty)
        } catch { /* The root may already be retired. */ }
      }))

      return once(() => {
        for (const dispose of cleanup.splice(0).reverse()) dispose()
      })
    },

    registerPreview(handler) {
      if (typeof handler !== 'function') return noop
      const register = ctx.ui?.registerHostIntentHandler
      if (typeof register !== 'function') return noop
      let registration: unknown
      try {
        registration = register.call(ctx.ui, 'image-preview', detail => {
          const request = normalizePreview(detail)
          if (!request) return false
          try { return handler(request) === true } catch { return false }
        })
      } catch {
        return noop
      }
      return disposer(registration)
    },

    registerSettings(render) {
      // Productivity owns one suite-level settings registration. Keep this
      // compatibility method as an inert disposer for older callers.
      void render
      return noop
    },
  }
}
