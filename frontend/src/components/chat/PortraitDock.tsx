import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  LockKeyhole,
  Maximize2,
  Minimize2,
  PanelRight,
  PictureInPicture2,
  Pin,
  PinOff,
  Ratio,
  X,
} from 'lucide-react'
import ContextMenu, { type ContextMenuEntry, type ContextMenuPos } from '@/components/shared/ContextMenu'
import {
  clampSurfaceRect,
  toLayoutBox,
  usePersistentRect,
  viewportBox,
  type DragMode,
  type RectBounds,
} from '@/hooks/usePersistentRect'
import { imagesApi } from '@/api/images'
import { assertNever } from '@/lib/assertNever'
import { getCharacterAvatarUrl } from '@/lib/avatarUrls'
import { resolveChatContentWidthForReclaim } from '@/lib/chatContentWidth'
import { hostIntentEventName } from '@/lib/spindle/host-intent-registry'
import { LumiverseSuiteGate } from '@/lib/spindle/LumiverseSuiteGate'
import { DEFAULT_PORTRAIT_DOCK_SETTINGS } from '@/lib/uiProductivityDefaults'
import { useStore } from '@/store'
import { canPersistPortraitDockInitialization } from '@/store/slices/settings'
import type { FloatingAvatarState, PortraitDockSettings, SettingsWriteSource, SurfaceRectPrefs } from '@/types/store'
import styles from './PortraitDock.module.css'

const VIEWPORT_PAD = 12
const CHAT_GAP = -20
const DEFAULT_RATIO = 1
const SMALLER_SCALE = 0.72
const RESIZE_DIRECTIONS: Array<Exclude<DragMode, 'move'>> = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']

interface ImageNaturalSize {
  width: number
  height: number
}

type FitMode = 'available' | 'natural' | 'smaller'

interface PortraitDockProps {
  mobile?: boolean
  extensionOwned?: boolean
}

export interface ManualPortraitPreviewOwner {
  chatId: string | null
  avatarId: string | null
  imageUrl: string
}

export function ownsPortraitPreviewForContext(
  preview: ManualPortraitPreviewOwner | null,
  chatId: string | null,
  avatarId: string | null,
) {
  return preview?.chatId === chatId && preview.avatarId === avatarId
}

/** The extension dock must never render a native-owned floating viewer record. */
export function portraitDockOwnsFloatingAvatar(
  floatingAvatar: Pick<FloatingAvatarState, 'owner'> | null,
  extensionOwned: boolean,
): boolean {
  return Boolean(floatingAvatar) && (!extensionOwned || floatingAvatar?.owner === 'portrait-dock')
}

function getViewportBounds(settings: PortraitDockSettings): RectBounds {
  if (typeof window === 'undefined') {
    return {
      minWidth: settings.minWidth,
      minHeight: settings.minHeight,
      maxWidth: settings.maxWidth,
      maxHeight: settings.maxHeight,
    }
  }

  // Layout units, the space `clampSurfaceRect` and `resizeSurfaceRect` work in. Under
  // `body > * { zoom: var(--lumiverse-ui-scale) }` (`theme/reset.css`) the raw window
  // viewport is reported in *rendered* px — too large by exactly the ui scale — so feeding
  // it in as a bound let the dock be fitted to a box larger than the viewport it lives in.
  const { width: vw, height: vh } = viewportBox()
  return {
    minWidth: Math.min(settings.minWidth, vw - VIEWPORT_PAD * 2),
    minHeight: Math.min(settings.minHeight, vh - VIEWPORT_PAD * 2),
    maxWidth: Math.max(settings.minWidth, Math.min(settings.maxWidth, vw - VIEWPORT_PAD * 2)),
    maxHeight: Math.max(settings.minHeight, Math.min(settings.maxHeight, vh - VIEWPORT_PAD * 2)),
  }
}

export function resolvePortraitRatio(naturalSize: ImageNaturalSize | null) {
  if (!naturalSize || naturalSize.height <= 0) return DEFAULT_RATIO
  const ratio = naturalSize.width / naturalSize.height
  return Number.isFinite(ratio) && ratio > 0 ? ratio : DEFAULT_RATIO
}

export function fitPortraitSize(
  ratio: number,
  bounds: RectBounds,
  mode: FitMode,
  naturalSize: ImageNaturalSize | null,
): Pick<SurfaceRectPrefs, 'width' | 'height'> {
  const targetWidth = mode === 'natural' && naturalSize ? naturalSize.width : bounds.maxWidth
  const targetHeight = mode === 'natural' && naturalSize ? naturalSize.height : bounds.maxHeight
  let width = Math.min(bounds.maxWidth ?? targetWidth, targetWidth)
  let height = Math.round(width / ratio)

  if (height > Math.min(bounds.maxHeight ?? targetHeight, targetHeight)) {
    height = Math.min(bounds.maxHeight ?? targetHeight, targetHeight)
    width = Math.round(height * ratio)
  }

  if (mode === 'smaller') {
    width = Math.round(width * SMALLER_SCALE)
    height = Math.round(height * SMALLER_SCALE)
  }

  const minScale = Math.max(bounds.minWidth / Math.max(1, width), bounds.minHeight / Math.max(1, height), 1)
  width = Math.round(width * minScale)
  height = Math.round(height * minScale)

  const maxScale = Math.min(
    (bounds.maxWidth ?? width) / Math.max(1, width),
    (bounds.maxHeight ?? height) / Math.max(1, height),
    1,
  )
  width = Math.round(width * maxScale)
  height = Math.round(height * maxScale)

  return {
    width: Math.max(bounds.minWidth, Math.min(bounds.maxWidth ?? width, width)),
    height: Math.max(bounds.minHeight, Math.min(bounds.maxHeight ?? height, height)),
  }
}

/**
 * Space-agnostic: exact in whatever units it is handed. `height` is a layout-px rect extent,
 * so the implicit viewport has to be the scale-aware, layout-px one rather than the raw
 * window height. Its SSR fallback is 1080, matching the literal this used to carry.
 */
export function getPortraitBottomY(height: number, viewportHeight?: number) {
  const availableHeight = viewportHeight ?? viewportBox().height
  return Math.max(VIEWPORT_PAD, availableHeight - height - VIEWPORT_PAD)
}

export function placePortraitRect(
  size: Pick<SurfaceRectPrefs, 'width' | 'height'>,
  side: 'left' | 'right',
  // A layout-px box rather than a `Window`, so a caller cannot accidentally hand this the
  // rendered-px `window` and get an x that is off-screen by the ui scale.
  viewport?: { width: number; height: number },
): SurfaceRectPrefs {
  if (!viewport && typeof window === 'undefined') return { x: 0, y: 0, ...size }
  const currentViewport = viewport ?? viewportBox()
  const x = side === 'left'
    ? VIEWPORT_PAD
    : Math.max(VIEWPORT_PAD, currentViewport.width - size.width - VIEWPORT_PAD)
  const y = getPortraitBottomY(size.height, currentViewport.height)
  return { ...size, x, y }
}

/** Docked portraits always use their side anchor while retaining their lane position. */
export function placeDockedPortraitRect(
  size: Pick<SurfaceRectPrefs, 'width' | 'height'>,
  side: 'left' | 'right',
  bounds: RectBounds,
  viewport: { width: number; height: number },
  y?: number,
): SurfaceRectPrefs {
  const anchored = placePortraitRect(size, side, viewport)
  return clampSurfaceRect({ ...anchored, ...(y === undefined ? {} : { y }) }, bounds, viewport)
}

export function isDefaultPortraitRect(rect: SurfaceRectPrefs) {
  const defaultRect = DEFAULT_PORTRAIT_DOCK_SETTINGS.rect
  return rect.x === defaultRect.x
    && rect.y === defaultRect.y
    && rect.width === defaultRect.width
    && rect.height === defaultRect.height
}

export function resolveDockedPortraitImageRect(
  fitSize: Pick<SurfaceRectPrefs, 'width' | 'height'>,
  savedRect: SurfaceRectPrefs,
  side: 'left' | 'right',
  bounds: RectBounds,
  viewport: { width: number; height: number },
) {
  const size = isDefaultPortraitRect(savedRect) ? fitSize : savedRect
  return placeDockedPortraitRect(size, side, bounds, viewport, savedRect.y)
}

export function getPortraitLayoutReclaim(
  bodyWidth: number,
  chatContentWidth: number,
  portraitWidth: number,
) {
  const contentWidth = Math.min(bodyWidth, chatContentWidth)
  const naturalGutter = Math.max(0, (bodyWidth - contentWidth) / 2)
  const reservedWidth = Math.min(
    portraitWidth,
    Math.max(0, 2 * (portraitWidth + CHAT_GAP - naturalGutter)),
  )
  return Math.max(0, portraitWidth - reservedWidth)
}

const CHAT_BODY_SELECTOR = '[data-lumiverse-surface="chat-body"]'
const CHAT_COLUMN_SELECTOR = '[data-lumiverse-surface="chat-column"]'
const CHAT_CONTENT_SELECTOR = '[data-lumiverse-surface="chat-column-inner"]'

export interface PortraitLayoutTargets {
  bodyElement: HTMLElement
  chatColumn: HTMLElement
  chatContent: HTMLElement
}

/**
 * `closest()` walks the DOM ancestor chain, which the Spindle host surface preserves:
 * the mount, the extension root, the host surface, and the surface node are all
 * `display: contents`, so they are laid out as if absent but remain ancestors. That is
 * why `parentElement` cannot be used here.
 *
 * The two inner lookups use `:scope >` because the markers are direct children in the
 * rendered frame: `ChatView.tsx` renders `chat-column` as a direct child of the
 * `chat-body` element, and `chat-column-inner` as a direct child of `chat-column`.
 * Verified against the current source, so the child queries match the real DOM and
 * cannot drift onto a nested namesake.
 *
 * Resolution is all-or-nothing so a partially committed chat frame cannot produce a
 * half-measured reclaim.
 */
export function resolvePortraitLayoutTargets(
  dockElement: HTMLElement | null,
): PortraitLayoutTargets | null {
  const bodyElement = dockElement?.closest<HTMLElement>(CHAT_BODY_SELECTOR) ?? null
  if (!bodyElement) return null
  const chatColumn = bodyElement.querySelector<HTMLElement>(`:scope > ${CHAT_COLUMN_SELECTOR}`)
  const chatContent = chatColumn?.querySelector<HTMLElement>(`:scope > ${CHAT_CONTENT_SELECTOR}`) ?? null
  if (!chatColumn || !chatContent) return null
  return { bodyElement, chatColumn, chatContent }
}

/**
 * The negative margin always goes on the dock's inner side. Nothing vertical here:
 * vertical placement stays `top: panel.rect.y` on `dockStyle`, with no offset token and
 * no transform.
 *
 * `inset` clamps a negative reclaim to zero. `getPortraitLayoutReclaim` already floors at
 * zero and the deliberate floating/mobile path writes exactly zero, so the clamp is a
 * guard rather than a behavior change.
 */
export function resolveDockReclaimStyle(
  side: PortraitDockSettings['dockSide'],
  reclaim: number,
): CSSProperties {
  const inset = -Math.max(0, reclaim)
  switch (side) {
    case 'left': return { order: -1, marginRight: inset }
    case 'right': return { marginLeft: inset }
    case 'floating': return {}
    default: return assertNever(side)
  }
}

/** A docked drag transfers sides when the portrait crosses the chat midpoint. */
export function resolveDockSideForRect(
  rect: Pick<SurfaceRectPrefs, 'x' | 'width'>,
  viewport: { width: number },
): 'left' | 'right' {
  return rect.x + rect.width / 2 < viewport.width / 2 ? 'left' : 'right'
}

/** A user close suppresses same-chat auto-open until the chat changes. */
export function shouldAutoOpenPortraitForChat(
  activeChatId: string | null,
  closedChatId: string | null,
  open: boolean,
): boolean {
  return Boolean(activeChatId) && (open || closedChatId !== activeChatId)
}

export default function PortraitDock(props: PortraitDockProps) {
  return <LumiverseSuiteGate><PortraitDockSurface {...props} /></LumiverseSuiteGate>
}

function PortraitDockSurface({ mobile = false, extensionOwned = false }: PortraitDockProps) {
  const floatingAvatar = useStore((s) => s.floatingAvatar)
  const settings = useStore((s) => s.portraitDockSettings)
  const settingsLoaded = useStore((s) => s.settingsLoaded)
  const fullSettingsLoaded = useStore((s) => s.fullSettingsLoaded)
  const activeChatId = useStore((s) => s.activeChatId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeChatAvatarId = useStore((s) => s.activeChatAvatarId)
  const characters = useStore((s) => s.characters)
  // Read-only. These are the sole source of the `--lumiverse-chat-content-width` value
  // `ChatView` publishes, so reading them here makes the reclaim math and the published
  // variable two consumers of one resolver instead of one reading back the other's
  // rendered result. Never written from this component.
  const chatWidthMode = useStore((s) => s.chatWidthMode)
  const chatContentMaxWidth = useStore((s) => s.chatContentMaxWidth)
  const updateFloatingAvatar = useStore((s) => s.updateFloatingAvatar)
  const openFloatingAvatar = useStore((s) => s.openFloatingAvatar)
  const closeFloatingAvatar = useStore((s) => s.closeFloatingAvatar)
  const setSetting = useStore((s) => s.setSetting)
  const [naturalSize, setNaturalSize] = useState<ImageNaturalSize | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuPos | null>(null)
  const [layoutReclaim, setLayoutReclaim] = useState(0)
  const [chatPortraitAvailable, setChatPortraitAvailable] = useState(true)
  const [dockElement, setDockElement] = useState<HTMLElement | null>(null)
  const initializedImageRef = useRef<string | null>(null)
  const previousChatIdRef = useRef<string | null>(null)
  const autoSyncedChatIdRef = useRef<string | null>(null)
  const closedChatIdRef = useRef<string | null>(null)
  const manualPreviewRef = useRef<ManualPortraitPreviewOwner | null>(null)
  const settingsTraceRef = useRef(0)

  useEffect(() => {
    settingsTraceRef.current += 1
    console.debug('[PortraitDockTrace]', {
      seq: settingsTraceRef.current,
      at: new Date().toISOString(),
      stage: 'settings:observed',
      extensionOwned,
      settingsLoaded,
      fullSettingsLoaded,
      open: settings.open,
      dockSide: settings.dockSide,
      defaultDockSide: settings.defaultDockSide,
      rememberSizePosition: settings.rememberSizePosition,
      pinned: settings.pinned,
      aspectRatioLocked: settings.aspectRatioLocked,
      rect: settings.rect,
    })
  }, [extensionOwned, fullSettingsLoaded, settings, settingsLoaded])

  const bounds = useMemo(() => getViewportBounds(settings), [settings])
  const ratio = resolvePortraitRatio(naturalSize)
  const isFloating = settings.dockSide === 'floating'

  const commitRect = useCallback((next: SurfaceRectPrefs, source: SettingsWriteSource) => {
    if (!floatingAvatar) return
    let rect = next
    let dockSide = settings.dockSide
    if (!mobile && settings.dockSide !== 'floating') {
      const viewport = viewportBox()
      dockSide = resolveDockSideForRect(next, viewport)
      rect = placeDockedPortraitRect(
        next,
        dockSide,
        getViewportBounds(settings),
        viewport,
        next.y,
      )
    }
    updateFloatingAvatar(rect)
    if (!settings.rememberSizePosition && dockSide === settings.dockSide) return

    if (source !== 'user-interaction') return
    setSetting('portraitDockSettings', { ...settings, rect, dockSide }, source)
  }, [floatingAvatar, mobile, setSetting, settings, updateFloatingAvatar])

  const sourceRect = useMemo(() => {
    if (!floatingAvatar || settings.rememberSizePosition) return settings.rect
    return {
      x: Math.max(0, floatingAvatar.x),
      y: Math.max(0, floatingAvatar.y),
      width: floatingAvatar.width,
      height: floatingAvatar.height,
    }
  }, [floatingAvatar, settings.rect, settings.rememberSizePosition])
  const panel = usePersistentRect({
    rect: sourceRect,
    bounds,
    onCommit: commitRect,
    snapToEdge: settings.snapToEdge,
    preserveAspectRatio: settings.aspectRatioLocked,
    aspectRatio: ratio,
  })

  const updateSettings = useCallback((partial: Partial<PortraitDockSettings>, source: SettingsWriteSource = 'user-interaction') => {
    if (source !== 'user-interaction' && !canPersistPortraitDockInitialization(fullSettingsLoaded)) return
    setSetting('portraitDockSettings', { ...settings, ...partial }, source)
  }, [fullSettingsLoaded, setSetting, settings])

  const closePortraitDock = useCallback(() => {
    manualPreviewRef.current = null
    closedChatIdRef.current = activeChatId
    updateSettings({ open: false })
    closeFloatingAvatar()
  }, [activeChatId, closeFloatingAvatar, updateSettings])

  useEffect(() => {
    if (!extensionOwned || typeof window === 'undefined') return

    const onPreview = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return
      const { imageUrl, caption } = detail as { imageUrl?: unknown; caption?: unknown }
      if (typeof imageUrl !== 'string' || imageUrl.trim().length === 0) return
      const displayName = typeof caption === 'string' && caption.trim().length > 0 ? caption : 'Image preview'
      const side = settings.dockSide === 'left' ? 'left' : settings.dockSide === 'right' ? 'right' : settings.defaultDockSide
      const rect = !isFloating && !mobile
        ? placeDockedPortraitRect(settings.rect, side, bounds, viewportBox(), settings.rect.y)
        : settings.rect

      if (activeChatId) {
        previousChatIdRef.current = activeChatId
      }
      manualPreviewRef.current = { chatId: activeChatId, avatarId: activeChatAvatarId, imageUrl }
      openFloatingAvatar(imageUrl, displayName, 'portrait-dock')
      updateFloatingAvatar(rect)
      setSetting('portraitDockSettings', {
        ...settings,
        open: true,
        rect,
        lastPortrait: { imageUrl, displayName },
      }, 'state-sync')
      event.preventDefault()
    }

    const eventName = hostIntentEventName('image-preview')
    window.addEventListener(eventName, onPreview)
    return () => window.removeEventListener(eventName, onPreview)
  }, [activeChatAvatarId, activeChatId, bounds, extensionOwned, isFloating, mobile, openFloatingAvatar, setSetting, settings, updateFloatingAvatar])

  const applyFit = useCallback((mode: FitMode) => {
    if (!floatingAvatar) return
    const size = fitPortraitSize(ratio, bounds, mode, naturalSize)
    const side = settings.dockSide === 'left' ? 'left' : settings.dockSide === 'right' ? 'right' : settings.defaultDockSide
    const nextRect = !isFloating && !mobile
      ? placeDockedPortraitRect(size, side, bounds, viewportBox(), panel.rect.y)
      : clampSurfaceRect({ ...panel.rect, ...size }, bounds)
    panel.setRect(nextRect)
    setContextMenu(null)
  }, [bounds, floatingAvatar, isFloating, mobile, naturalSize, panel, ratio, settings.defaultDockSide, settings.dockSide])

  const setDockSide = useCallback((dockSide: PortraitDockSettings['dockSide']) => {
    const rect = dockSide === 'floating'
      ? clampSurfaceRect(panel.rect, bounds, viewportBox())
      : placeDockedPortraitRect(panel.rect, dockSide, bounds, viewportBox(), panel.rect.y)
    updateSettings({ dockSide, rect })
    updateFloatingAvatar(rect)
    setContextMenu(null)
  }, [bounds, panel.rect, updateFloatingAvatar, updateSettings])

  const resetCurrentLayout = useCallback(() => {
    const side = settings.defaultDockSide
    const rect = placePortraitRect(DEFAULT_PORTRAIT_DOCK_SETTINGS.rect, side)
    updateSettings({
      rect,
      dockSide: side,
      pinned: DEFAULT_PORTRAIT_DOCK_SETTINGS.pinned,
      aspectRatioLocked: settings.defaultAspectRatioLock,
    })
    updateFloatingAvatar(rect)
    setContextMenu(null)
  }, [settings.defaultAspectRatioLock, settings.defaultDockSide, updateFloatingAvatar, updateSettings])

  const resetAllSettings = useCallback(() => {
    manualPreviewRef.current = null
    closeFloatingAvatar()
    setSetting('portraitDockSettings', { ...DEFAULT_PORTRAIT_DOCK_SETTINGS })
    setContextMenu(null)
  }, [closeFloatingAvatar, setSetting])

  const startMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation()
    if ((event.target as HTMLElement).closest('button')) return
    panel.startDrag('move', event)
  }, [panel])

  useEffect(() => {
    if (!floatingAvatar?.imageUrl) return
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      const nextNaturalSize = { width: img.naturalWidth, height: img.naturalHeight }
      setNaturalSize(nextNaturalSize)
      if (initializedImageRef.current === floatingAvatar.imageUrl) return
      initializedImageRef.current = floatingAvatar.imageUrl
      const usesUntouchedDefaultRect = isDefaultPortraitRect(floatingAvatar)
        && isDefaultPortraitRect(settings.rect)
      const nextRatio = resolvePortraitRatio(nextNaturalSize)
      const size = fitPortraitSize(
        nextRatio,
        bounds,
        settings.openAtOriginalSize ? 'natural' : 'available',
        nextNaturalSize,
      )
      if (!isFloating && !mobile) {
        const side = settings.dockSide === 'left' ? 'left' : settings.dockSide === 'right' ? 'right' : settings.defaultDockSide
        panel.setRect(resolveDockedPortraitImageRect(size, settings.rect, side, bounds, viewportBox()))
        return
      }
      if (settings.rememberSizePosition && !isDefaultPortraitRect(settings.rect)) {
        panel.setRect(clampSurfaceRect(settings.rect, bounds))
        return
      }
      if (floatingAvatar.x >= 0 && floatingAvatar.y >= 0 && !usesUntouchedDefaultRect) return
      panel.setRect(clampSurfaceRect(placePortraitRect(size, settings.defaultDockSide), bounds))
    }
    img.src = floatingAvatar.imageUrl
    return () => {
      cancelled = true
    }
  }, [bounds, floatingAvatar, isFloating, mobile, panel, settings.defaultDockSide, settings.dockSide, settings.openAtOriginalSize, settings.rect, settings.rememberSizePosition])

  useEffect(() => {
    if (!activeChatId || !activeCharacterId) {
      manualPreviewRef.current = null
      previousChatIdRef.current = activeChatId
      autoSyncedChatIdRef.current = null
      setChatPortraitAvailable(false)
      return
    }

    const chatChanged = previousChatIdRef.current !== activeChatId
    if (chatChanged) closedChatIdRef.current = null
    if (!shouldAutoOpenPortraitForChat(activeChatId, closedChatIdRef.current, settings.open)) {
      previousChatIdRef.current = activeChatId
      setChatPortraitAvailable(true)
      return
    }
    const ownsCurrentPortrait = autoSyncedChatIdRef.current === activeChatId
      && floatingAvatar?.owner === 'portrait-dock'

    const manualPreview = manualPreviewRef.current
    if (ownsPortraitPreviewForContext(manualPreview, activeChatId, activeChatAvatarId)) {
      previousChatIdRef.current = activeChatId
      setChatPortraitAvailable(true)
      return
    }
    if (manualPreview) manualPreviewRef.current = null

    const character = characters.find((entry) => entry.id === activeCharacterId)
    if (!character) return

    const alternateAvatars = character.extensions?.alternate_avatars as Array<{
      image_id: string
      original_image_id?: string
    }> | undefined
    const alternateAvatar = activeChatAvatarId
      ? alternateAvatars?.find((entry) => entry.image_id === activeChatAvatarId)
      : null
    const originalImageId = alternateAvatar?.original_image_id
      ?? (typeof character.extensions?.original_image_id === 'string'
        ? character.extensions.original_image_id
        : null)
    const imageUrl = activeChatAvatarId
      ? imagesApi.url(alternateAvatar?.original_image_id ?? activeChatAvatarId)
      : originalImageId
        ? imagesApi.url(originalImageId)
        : getCharacterAvatarUrl(character)

    previousChatIdRef.current = activeChatId
    if (imageUrl) {
      setChatPortraitAvailable(true)
      if (!chatChanged && ownsCurrentPortrait && !floatingAvatar) return
      if (
        chatChanged
        || !ownsCurrentPortrait
        || floatingAvatar?.imageUrl !== imageUrl
        || floatingAvatar?.displayName !== character.name
      ) {
        // The character portrait is deliberately taking ownership back from a preview.
        manualPreviewRef.current = null
        autoSyncedChatIdRef.current = activeChatId
        openFloatingAvatar(imageUrl, character.name, 'portrait-dock')
      }
      if (
        settings.lastPortrait?.imageUrl !== imageUrl
        || settings.lastPortrait?.displayName !== character.name
        || !settings.open
      ) {
        if (!canPersistPortraitDockInitialization(fullSettingsLoaded)) {
          console.debug('[PortraitDockTrace]', {
            at: new Date().toISOString(),
            stage: 'settings:bootstrap-write-skipped',
            source: 'portrait-dock-init',
            reason: 'full-settings-not-hydrated',
            settingsLoaded,
            fullSettingsLoaded,
            beforeDockSide: settings.dockSide,
            afterDockSide: settings.dockSide,
            beforeOpen: settings.open,
            afterOpen: true,
            lastPortraitChanged: settings.lastPortrait?.imageUrl !== imageUrl
              || settings.lastPortrait?.displayName !== character.name,
          })
          return
        }
        setSetting('portraitDockSettings', {
          ...settings,
          open: true,
          lastPortrait: { imageUrl, displayName: character.name },
        }, 'portrait-dock-init')
      }
    } else {
      setChatPortraitAvailable(false)
    }
  }, [
    activeCharacterId,
    activeChatAvatarId,
    activeChatId,
    characters,
    fullSettingsLoaded,
    floatingAvatar,
    openFloatingAvatar,
    setSetting,
    settingsLoaded,
    settings,
    updateFloatingAvatar,
  ])

  useEffect(() => {
    if (!floatingAvatar) return
    const handleResize = () => {
      const nextBounds = getViewportBounds(settings)
      panel.setRect(clampSurfaceRect(panel.rect, nextBounds))
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [floatingAvatar, panel, settings])

  useLayoutEffect(() => {
    // The only deliberate zero: `floating` and `mobile` take the dock out of the chat
    // body's flex row entirely, so there is no gutter to reclaim. Every other former
    // bail-to-zero path is gone — a missing or unmeasured target now holds the current
    // value and retries instead of stranding the dock in its own lane.
    if (mobile || isFloating) {
      setLayoutReclaim(0)
      return
    }

    // The ref state change re-runs this effect as soon as the dock is committed. Until
    // then there is no node whose missing ancestors can become resolvable, so observing the
    // whole document would only retry forever while the dock is closed or unavailable.
    if (!dockElement) return

    let frame = 0
    let resizeObserver: ResizeObserver | null = null
    let mutationObserver: MutationObserver | null = null

    const measure = (targets: PortraitLayoutTargets) => {
      // `getBoundingClientRect()` is rendered px; `panel.rect.width` and the resolved
      // content width are layout px. `getPortraitLayoutReclaim` subtracts all three from
      // one another, so an unconverted body width produced a negative margin hundreds of
      // pixels too large and pulled the chat column under the portrait. `toLayoutBox`
      // divides out `--lumiverse-ui-scale`.
      const bodyWidth = toLayoutBox(targets.bodyElement.getBoundingClientRect()).width
      // A zero box means "not laid out yet", never "unconstrained". Hold the current
      // value; the ResizeObserver delivers again once the element has a box.
      if (!(bodyWidth > 0)) return
      // State-derived, not read back off the cascade: the moment hydration flips
      // `chatWidthMode`, this effect re-runs with the new input rather than waiting for a
      // computed `max-width` that may not have committed yet.
      const contentWidth = resolveChatContentWidthForReclaim(chatWidthMode, chatContentMaxWidth, bodyWidth)
      const next = Math.round(getPortraitLayoutReclaim(bodyWidth, contentWidth, panel.rect.width))
      setLayoutReclaim((current) => (current === next ? current : next))
    }

    const attach = (): boolean => {
      // Idempotent by design (Requirement 7.4). `attach()` is the only constructor of the
      // ResizeObserver and it owns the single binding cleanup can see, so a second successful
      // attach inside one effect run would overwrite that binding and leave the first observer
      // registered with nothing able to disconnect it. Re-entry reports the existing attach.
      if (resizeObserver) return true
      const targets = resolvePortraitLayoutTargets(dockElement)
      if (!targets) return false
      measure(targets)
      // Assigned to the outer binding before returning, so a late attach from the retry
      // path is still visible to cleanup.
      resizeObserver = new ResizeObserver(() => measure(targets))
      resizeObserver.observe(targets.bodyElement)
      resizeObserver.observe(targets.chatColumn)
      resizeObserver.observe(targets.chatContent)
      return true
    }

    if (!attach()) {
      // Requirement 1.5: the chat frame may commit after this dock's bridge root does.
      const retry = () => {
        if (!attach()) return
        mutationObserver?.disconnect()
        mutationObserver = null
        // Both retry registrations below are live at once, and mutation records are delivered as
        // microtasks — they land BEFORE the animation frame requested alongside them. Without
        // this cancel the frame runs `retry` a second time after the attach already succeeded.
        // Do NOT remove as redundant. `frame = 0` keeps cleanup's `if (frame)` guard from
        // cancelling a handle that has already been released.
        if (frame) cancelAnimationFrame(frame)
        frame = 0
      }
      const ownerDocument = dockElement.ownerDocument
      mutationObserver = new MutationObserver(retry)
      mutationObserver.observe(ownerDocument.body, { childList: true, subtree: true })
      frame = requestAnimationFrame(retry)
    }

    return () => {
      if (frame) cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      resizeObserver = null
      mutationObserver = null
    }
  }, [
    chatContentMaxWidth,
    chatWidthMode,
    dockElement,
    isFloating,
    mobile,
    panel.rect.width,
    settings.dockSide,
  ])

  const contextMenuItems = useMemo<ContextMenuEntry[]>(() => [
    { key: 'natural', label: 'Restore original size', onClick: () => applyFit('natural') },
    { key: 'fit', label: 'Fit to available space', onClick: () => applyFit('available') },
    {
      key: 'aspect',
      label: settings.aspectRatioLocked ? 'Unlock aspect ratio' : 'Lock aspect ratio',
      active: settings.aspectRatioLocked,
      onClick: () => {
        updateSettings({ aspectRatioLocked: !settings.aspectRatioLocked })
        setContextMenu(null)
      },
    },
    { key: 'layout-divider', type: 'divider' },
    { key: 'reset-position', label: 'Reset position', onClick: resetCurrentLayout },
    { key: 'dock-left', label: 'Dock left', active: settings.dockSide === 'left', onClick: () => setDockSide('left') },
    { key: 'dock-right', label: 'Dock right', active: settings.dockSide === 'right', onClick: () => setDockSide('right') },
    { key: 'float', label: 'Float / undock', active: settings.dockSide === 'floating', onClick: () => setDockSide('floating') },
    { key: 'preferences-divider', type: 'divider' },
    {
      key: 'pin',
      label: settings.pinned ? 'Unpin portrait' : 'Pin portrait',
      active: settings.pinned,
      onClick: () => {
        updateSettings({ pinned: !settings.pinned })
        setContextMenu(null)
      },
    },
    {
      key: 'hover-controls',
      label: settings.hoverControls ? 'Hide hover controls' : 'Show hover controls',
      active: settings.hoverControls,
      onClick: () => {
        updateSettings({ hoverControls: !settings.hoverControls })
        setContextMenu(null)
      },
    },
    { key: 'close-divider', type: 'divider' },
    { key: 'close', label: 'Close portrait', onClick: closePortraitDock },
    { key: 'reset-all', label: 'Reset Portrait Dock settings', danger: true, onClick: resetAllSettings },
  ], [
    applyFit,
    closePortraitDock,
    resetAllSettings,
    resetCurrentLayout,
    setDockSide,
    settings.aspectRatioLocked,
    settings.dockSide,
    settings.hoverControls,
    settings.pinned,
    updateSettings,
  ])

  if (
    !settings.enabled
    || !settings.open
    || !floatingAvatar
    || !portraitDockOwnsFloatingAvatar(floatingAvatar, extensionOwned)
    || !activeChatId
    || !activeCharacterId
    || !chatPortraitAvailable
    || previousChatIdRef.current !== activeChatId
  ) return null

  const dockStyle: CSSProperties & {
    '--portrait-dock-ratio': number
  } = {
    width: panel.rect.width,
    height: panel.rect.height,
    '--portrait-dock-ratio': ratio,
    ...(!isFloating && !mobile
      ? {
          top: panel.rect.y,
          ...resolveDockReclaimStyle(settings.dockSide, layoutReclaim),
        }
      : {}),
    ...((isFloating || mobile)
      ? { left: panel.rect.x, top: panel.rect.y }
      : {}),
  }

  const dock = (
    <aside
      ref={setDockElement}
      className={[
        styles.dock,
        mobile ? styles.mobileDock : isFloating ? styles.floatingDock : styles.dockedDock,
      ].join(' ')}
      style={dockStyle}
      aria-label={`${floatingAvatar.displayName} portrait dock`}
      onPointerDown={startMove}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setContextMenu({ x: event.clientX, y: event.clientY })
      }}
    >
      <img src={floatingAvatar.imageUrl} alt="" className={styles.image} draggable={false} />
      {settings.hoverControls && (
        <div className={styles.controls} role="toolbar" aria-label="Portrait dock controls">
          <button
            type="button"
            onClick={() => updateSettings({ pinned: !settings.pinned })}
            title={settings.pinned ? 'Unpin portrait' : 'Pin portrait'}
            aria-label={settings.pinned ? 'Unpin portrait' : 'Pin portrait'}
          >
            {settings.pinned
              ? <Pin size={settings.hoverControlSize} aria-hidden="true" />
              : <PinOff size={settings.hoverControlSize} aria-hidden="true" />}
          </button>
          <button
            type="button"
            onClick={() => updateSettings({ aspectRatioLocked: !settings.aspectRatioLocked })}
            title={settings.aspectRatioLocked ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
            aria-label={settings.aspectRatioLocked ? 'Unlock portrait aspect ratio' : 'Lock portrait aspect ratio'}
          >
            {settings.aspectRatioLocked
              ? <LockKeyhole size={settings.hoverControlSize} aria-hidden="true" />
              : <Ratio size={settings.hoverControlSize} aria-hidden="true" />}
          </button>
          <button
            type="button"
            onClick={() => setDockSide(isFloating ? settings.defaultDockSide : 'floating')}
            title={isFloating ? `Dock portrait ${settings.defaultDockSide}` : 'Float portrait over chat and dialogs'}
            aria-label={isFloating ? `Dock portrait ${settings.defaultDockSide}` : 'Float portrait over chat and dialogs'}
          >
            {isFloating
              ? <PanelRight size={settings.hoverControlSize} aria-hidden="true" />
              : <PictureInPicture2 size={settings.hoverControlSize} aria-hidden="true" />}
          </button>
          <button type="button" onClick={() => applyFit('smaller')} title="Fit smaller" aria-label="Fit portrait smaller">
            <Minimize2 size={settings.hoverControlSize} aria-hidden="true" />
          </button>
          <button type="button" onClick={() => applyFit('natural')} title="Original size" aria-label="Show portrait at original size">
            <span aria-hidden="true">1x</span>
          </button>
          <button type="button" onClick={() => applyFit('available')} title="Fit available" aria-label="Fit portrait to available space">
            <Maximize2 size={settings.hoverControlSize} aria-hidden="true" />
          </button>
          <button type="button" onClick={closePortraitDock} title="Close portrait dock" aria-label="Close portrait dock">
            <X size={settings.hoverControlSize} aria-hidden="true" />
          </button>
        </div>
      )}
      {RESIZE_DIRECTIONS.map((direction) => (
        <button
          key={direction}
          type="button"
          className={`${styles.resizeHandle} ${styles[`resize${direction.toUpperCase()}`]}`}
          aria-label={`Resize portrait dock ${direction}`}
          onPointerDown={(event) => {
            event.stopPropagation()
            panel.startDrag(direction, event)
          }}
        />
      ))}
    </aside>
  )

  return (
    <>
      {isFloating && !mobile && typeof document !== 'undefined'
        ? createPortal(<div className={styles.floatingLayer}>{dock}</div>, document.body)
        : dock}
      <ContextMenu position={contextMenu} items={contextMenuItems} onClose={() => setContextMenu(null)} />
    </>
  )
}
