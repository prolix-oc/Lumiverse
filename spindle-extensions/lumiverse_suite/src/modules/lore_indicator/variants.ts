import { createLorePanel, type LorePanelController } from './panel'
import { createV4ConfigPopover, createV4PanelPopover } from './popover'
import { createV5Palette, type V5PaletteController } from './palette'
import type { LoreActivationStats, LoreActivationSummary, LoreSurfacePoint, LoreSurfaceRect } from './models'
import type { LoreIndicatorSettings } from './settings-model'
import { formatCompactNumber, getConfiguredV4Items, provenanceLabel } from './utils'

export interface LoreGeometryPort {
  layoutViewportSize(): { width: number; height: number }
  layoutElementRect(element: Element): LoreSurfaceRect
  layoutElementSize(element: Element, fallback: { width: number; height: number }): { width: number; height: number }
  /** Pointer coordinates are already converted to layout space by the host adapter. */
  toLayoutDelta?(x: number, y: number): { x: number; y: number }
  readPointer(event: PointerEvent): { x: number; y: number }
}

export interface LoreFloatPort {
  readonly root: HTMLElement
  getPosition?(): LoreSurfacePoint
  moveTo(x: number, y: number): void
  setSize(width: number, height: number): void
  onDragEnd(handler: (position: LoreSurfacePoint) => void): () => void
}

export interface LoreOverlayPort {
  readonly root: HTMLElement
  setVisible?(visible: boolean): void
  destroy?(): void
}

export interface LoreVariantOptions {
  readonly document: Document
  readonly mount: Element
  readonly entries: readonly LoreActivationSummary[]
  readonly stats: LoreActivationStats
  readonly settings: LoreIndicatorSettings
  readonly geometry?: LoreGeometryPort
  readonly float?: LoreFloatPort
  readonly overlay?: LoreOverlayPort
  readonly onOpenEntry?: (entry: LoreActivationSummary) => void
  readonly onSettingsChange?: (settings: LoreIndicatorSettings) => void
}

export interface LoreVariantController {
  readonly element: HTMLElement
  update(options: Partial<Pick<LoreVariantOptions, 'entries' | 'stats' | 'settings'>>): void
  destroy(): void
}

const EXTENSION_ROOT_ATTRIBUTE = 'data-spindle-extension-root'
const EXTENSION_ATTRIBUTE = 'data-spindle-ext'

function extensionUuidFor(node: Element): string | undefined {
  const candidate = node.closest<HTMLElement>(`[${EXTENSION_ROOT_ATTRIBUTE}], [${EXTENSION_ATTRIBUTE}]`)
  const value = candidate?.getAttribute(EXTENSION_ROOT_ATTRIBUTE) ?? candidate?.getAttribute(EXTENSION_ATTRIBUTE)
  return value && value.length > 0 ? value : undefined
}

function markOwnedNode(node: HTMLElement, extensionUuid: string | undefined, variant: string): HTMLElement {
  if (!extensionUuid) throw new Error('LORE_INDICATOR_EXTENSION_UUID_UNAVAILABLE')
  node.setAttribute('data-lumiverse-module', 'lore_indicator')
  node.setAttribute(EXTENSION_ROOT_ATTRIBUTE, extensionUuid)
  node.setAttribute(EXTENSION_ATTRIBUTE, extensionUuid)
  node.dataset.variant = variant
  return node
}

function ownedRoot(document: Document, mount: Element, variant: string): HTMLElement {
  const extensionUuid = extensionUuidFor(mount)
  const root = document.createElement('div')
  markOwnedNode(root, extensionUuid, variant)
  mount.append(root)
  return root
}

function ownedBodyLayer(document: Document, mount: Element, variant: string): HTMLElement {
  const root = document.createElement('div')
  markOwnedNode(root, extensionUuidFor(mount), variant)
  mount.append(root)
  root.className = 'lumiverse-lore-indicator__body-layer'
  root.dataset.layer = 'body'
  return root
}

function cloneSettings(settings: LoreIndicatorSettings): LoreIndicatorSettings {
  return {
    ...settings,
    visibleMetadata: [...settings.visibleMetadata],
    typeAppearance: Object.fromEntries(
      Object.entries(settings.typeAppearance).map(([key, value]) => [key, { ...value }]),
    ) as LoreIndicatorSettings['typeAppearance'],
    v2: { ...settings.v2, position: { ...settings.v2.position } },
    v4: { ...settings.v4, items: settings.v4.items.map((item) => ({ ...item })) },
    v5: { ...settings.v5, rect: { ...settings.v5.rect } },
  }
}

function trigger(document: Document, label: string, className: string): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = className
  element.setAttribute('aria-label', label)
  return element
}

export function createV2Compact(options: LoreVariantOptions): LoreVariantController {
  const root = options.float?.root ?? ownedRoot(options.document, options.mount, 'v2-compact')
  const ownsRoot = !options.float
  const extensionUuid = extensionUuidFor(root) ?? extensionUuidFor(options.mount)
  if (extensionUuid) markOwnedNode(root, extensionUuid, 'v2-compact')
  else {
    root.setAttribute('data-lumiverse-module', 'lore_indicator')
    root.dataset.variant = 'v2-compact'
  }
  root.dataset.layer = 'body'
  let entries = options.entries
  let stats = options.stats
  let settings = options.settings
  let panel: LorePanelController | undefined
  let closedTimer: ReturnType<typeof setTimeout> | undefined
  let destroyed = false

  const close = () => {
    if (closedTimer) clearTimeout(closedTimer)
    closedTimer = undefined
    panel?.destroy()
    panel = undefined
  }
  const scheduleClose = () => {
    if (settings.v2.activationMode !== 'hover') return
    if (closedTimer) clearTimeout(closedTimer)
    closedTimer = setTimeout(close, 120)
  }
  const open = () => {
    if (destroyed || panel) return
    const popover = options.document.createElement('div')
    markOwnedNode(popover, extensionUuidFor(options.float?.root ?? options.mount), 'v2-popover')
    popover.className = 'lumiverse-lore-indicator__popover lumiverse-lore-indicator__popover--v2'
    popover.setAttribute('role', 'dialog')
    popover.setAttribute('aria-label', 'Activated lore')
    popover.dataset.portal = 'body'
    ;(options.overlay?.root ?? options.mount).append(popover)
    const viewport = options.geometry?.layoutViewportSize() ?? { width: 1280, height: 800 }
    const triggerSize = options.geometry?.layoutElementSize(root, { width: 72, height: 32 }) ?? { width: 72, height: 32 }
    const columns = Math.max(1, Math.floor((viewport.width - 24) / 240))
    popover.style.setProperty('--lumiverse-lore-columns', String(columns))
    popover.style.maxWidth = `${Math.max(240, Math.min(viewport.width - 24, columns * 240))}px`
    const position = options.float?.root ? options.float.getPosition?.() : settings.v2.position
    const point = position ?? settings.v2.position
    const left = Math.max(12, Math.min(point.x, viewport.width - triggerSize.width - 12))
    const top = Math.max(12, Math.min(point.y + triggerSize.height + 8, viewport.height - 12))
    popover.style.left = `${left}px`
    popover.style.top = `${top}px`
    panel = createLorePanel({
      document: options.document,
      mode: 'compact',
      entries,
      stats,
      settings,
      activateOnClick: true,
      onOpen: options.onOpenEntry,
    })
    popover.append(panel.element)
    popover.addEventListener('mouseenter', () => { if (closedTimer) clearTimeout(closedTimer) })
    popover.addEventListener('mouseleave', scheduleClose)
    const originalDestroy = panel.destroy
    panel.destroy = () => {
      originalDestroy()
      popover.remove()
    }
  }

  const compactTrigger = trigger(options.document, 'Open activated lore', 'lumiverse-lore-indicator__trigger')
  compactTrigger.textContent = `${formatCompactNumber(entries.length)} lore`
  compactTrigger.addEventListener('click', () => {
    if (panel) close()
    else open()
  })
  compactTrigger.addEventListener('mouseenter', () => {
    if (settings.v2.activationMode === 'hover') open()
  })
  compactTrigger.addEventListener('mouseleave', scheduleClose)
  root.replaceChildren(compactTrigger)

  let stopDrag = options.float?.onDragEnd(position => {
    settings.v2.position = { ...position }
    options.onSettingsChange?.(cloneSettings(settings))
  })
  options.float?.moveTo(settings.v2.position.x, settings.v2.position.y)
  options.float?.setSize(72, 32)

  return {
    element: root,
    update(next) {
      if (destroyed) return
      entries = next.entries ?? entries
      stats = next.stats ?? stats
      settings = next.settings ?? settings
      compactTrigger.textContent = `${formatCompactNumber(entries.length)} lore`
      if (panel) panel.update({ entries, stats, settings })
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      if (closedTimer) clearTimeout(closedTimer)
      stopDrag?.()
      stopDrag = undefined
      panel?.destroy()
      if (ownsRoot) root.remove()
      else root.replaceChildren()
    },
  }
}

export function createV4BottomStrip(options: LoreVariantOptions): LoreVariantController {
  const root = ownedRoot(options.document, options.mount, 'v4-bottom-strip')
  const bodyLayer = ownedBodyLayer(options.document, options.mount, 'v4-popovers')
  root.className = 'lumiverse-lore-indicator__v4-root'
  root.dataset.variant = 'v4-bottom-strip'
  let entries = options.entries
  let stats = options.stats
  let settings = options.settings
  let panelPopover: ReturnType<typeof createV4PanelPopover> | undefined
  let configPopover: ReturnType<typeof createV4ConfigPopover> | undefined
  let destroyed = false

  const render = () => {
    root.replaceChildren()
    const strip = options.document.createElement('div')
    strip.className = 'lumiverse-lore-indicator__strip'
    strip.style.gap = `${settings.v4.spacing}px`
    strip.setAttribute('role', 'toolbar')
    strip.setAttribute('aria-label', 'Lore indicator')
    for (const item of getConfiguredV4Items(settings.v4.items).filter(candidate => candidate.visible && !candidate.removed)) {
      const itemButton = trigger(options.document, item.id, 'lumiverse-lore-indicator__strip-item')
      itemButton.dataset.itemId = item.id
      itemButton.dataset.mode = item.mode
      itemButton.dataset.activation = item.id === 'constant' || item.id === 'keyword' || item.id === 'vector' ? item.id : ''
      const value = itemValue(item.id, entries, stats)
      itemButton.textContent = item.mode === 'icon' ? itemIcon(item.id) : `${itemIcon(item.id)} ${value}`
      itemButton.title = `${value} ${item.id}`
      itemButton.addEventListener('click', () => {
        if (item.id === 'search' || item.id === 'grouping' || item.id === 'active-count' || item.id === 'token-estimate' || item.id === 'passes' || item.id === 'constant' || item.id === 'keyword' || item.id === 'vector' || item.id === 'lorebooks') {
          panelPopover?.destroy()
          panelPopover = undefined
          configPopover?.destroy()
          configPopover = undefined
          panelPopover = createV4PanelPopover({
            document: options.document,
            parent: bodyLayer,
            anchor: strip,
            geometry: options.geometry,
            entries,
            stats,
            settings,
            onOpen: options.onOpenEntry,
            onClose: () => { panelPopover?.destroy(); panelPopover = undefined },
          })
        }
      })
      strip.append(itemButton)
    }
    const configure = trigger(options.document, 'Configure lore indicator', 'lumiverse-lore-indicator__strip-item')
    configure.textContent = '⚙'
    configure.addEventListener('click', () => {
      configPopover?.destroy()
      configPopover = undefined
      panelPopover?.destroy()
      panelPopover = undefined
      configPopover = createV4ConfigPopover({
        document: options.document,
        parent: bodyLayer,
        anchor: strip,
        geometry: options.geometry,
        settings,
        onSettingsChange(next) {
          settings = next
          options.onSettingsChange?.(cloneSettings(next))
          render()
        },
        onClose: () => { configPopover?.destroy(); configPopover = undefined },
      })
    })
    strip.append(configure)
    root.append(strip)
  }
  render()

  return {
    element: root,
    update(next) {
      if (destroyed) return
      entries = next.entries ?? entries
      stats = next.stats ?? stats
      settings = next.settings ?? settings
      panelPopover?.destroy()
      configPopover?.destroy()
      panelPopover = undefined
      configPopover = undefined
      render()
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      panelPopover?.destroy()
      configPopover?.destroy()
      root.remove()
      bodyLayer.remove()
    },
  }
}

export function createV5CommandPalette(options: LoreVariantOptions): LoreVariantController {
  const root = options.overlay?.root ?? ownedRoot(options.document, options.mount, 'v5-command-palette')
  const ownsRoot = !options.overlay
  markOwnedNode(root, extensionUuidFor(root) ?? extensionUuidFor(options.mount), 'v5-command-palette')
  const controller = createV5Palette({
    ...options,
    root,
    onOpenEntry: options.onOpenEntry,
  })
  return {
    element: root,
    update(next) { controller.update(next) },
    destroy() {
      controller.destroy()
      options.overlay?.destroy?.()
      if (ownsRoot) root.remove()
    },
  }
}

export function createLoreVariant(options: LoreVariantOptions): LoreVariantController {
  if (options.settings.variant === 'v4-bottom-strip') return createV4BottomStrip(options)
  if (options.settings.variant === 'v5-command-palette') return createV5CommandPalette(options)
  return createV2Compact(options)
}

function itemValue(item: string, entries: readonly LoreActivationSummary[], stats: LoreActivationStats): string {
  if (item === 'active-count') return String(entries.length)
  if (item === 'token-estimate') return formatCompactNumber(stats.estimatedTokens)
  if (item === 'passes') return String(stats.recursionPassesUsed)
  if (item === 'constant') return String(entries.filter(entry => entry.provenance.origin === 'constant').length)
  if (item === 'keyword') return String(stats.keywordActivated)
  if (item === 'vector') return String(stats.vectorActivated)
  if (item === 'lorebooks') return String(new Set(entries.map(entry => entry.bookId ?? entry.bookName)).size)
  if (item === 'search') return 'Search'
  if (item === 'grouping') return provenanceLabel(entries[0]?.provenance ?? { origin: 'constant' })
  return '0'
}

function itemIcon(item: string): string {
  if (item === 'token-estimate') return '#'
  if (item === 'passes') return '△'
  if (item === 'grouping') return '≡'
  if (item === 'search') return '⌕'
  if (item === 'constant') return 'C'
  if (item === 'keyword') return 'K'
  if (item === 'vector') return 'V'
  return '◆'
}
