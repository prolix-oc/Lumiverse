import { hasTauriDesktopBridge } from '@/lib/desktopWebView'
import { invoke } from '@tauri-apps/api/core'
import type { FloatWidgetState } from '@/store/slices/spindle-placement'
import type { ExtensionInfo } from 'lumiverse-spindle-types'
import { filterEnabledFrontendContributions } from '@/lib/spindle/frontend-extension-availability'

export interface DesktopFloatingWidgetTarget {
  extensionId: string
  index: number
  title: string
  chromeless: boolean
  width: number
  height: number
}

export interface DesktopFloatingWidgetCatalogEntry {
  id: string
  extensionId: string
  index: number
  title: string
  width: number
  height: number
  chromeless: boolean
}

export interface DesktopFloatingWidgetPopoutState {
  id: string
  poppedOut: boolean
}

/** Native pop-out bounds the desktop host accepts and enforces. The Rust side
 * owns the same numbers in desktop/src-tauri/src/frontend.rs. */
export const DESKTOP_WIDGET_MIN_SIZE = { width: 160, height: 100 } as const
export const DESKTOP_WIDGET_CHROMELESS_MIN_SIZE = { width: 24, height: 24 } as const
export const DESKTOP_WIDGET_MAX_SIZE = { width: 1200, height: 900 } as const

export function desktopWidgetMinSize(chromeless: boolean): { width: number; height: number } {
  return chromeless ? DESKTOP_WIDGET_CHROMELESS_MIN_SIZE : DESKTOP_WIDGET_MIN_SIZE
}

function readTarget(): DesktopFloatingWidgetTarget | null {
  if (!hasTauriDesktopBridge()) return null

  const params = new URLSearchParams(window.location.search)
  const extensionId = params.get('desktopWidgetExtension')
  const index = Number(params.get('desktopWidgetIndex') ?? '0')
  const title = params.get('desktopWidgetTitle')
  const width = Number(params.get('desktopWidgetWidth'))
  const height = Number(params.get('desktopWidgetHeight'))
  const chromeless = params.get('desktopWidgetChromeless') === '1'
  const minSize = desktopWidgetMinSize(chromeless)
  if (
    !extensionId ||
    extensionId.length > 200 ||
    !Number.isInteger(index) ||
    index < 0 ||
    index > 3 ||
    !Number.isInteger(width) ||
    width < minSize.width ||
    width > DESKTOP_WIDGET_MAX_SIZE.width ||
    !Number.isInteger(height) ||
    height < minSize.height ||
    height > DESKTOP_WIDGET_MAX_SIZE.height
  ) {
    return null
  }
  return {
    extensionId,
    index,
    title: title?.slice(0, 120) || 'Extension widget',
    chromeless,
    width,
    height,
  }
}

export const desktopFloatingWidgetTarget = readTarget()

export function isDesktopFloatingWidgetWindow(): boolean {
  return desktopFloatingWidgetTarget !== null
}

export function buildDesktopFloatingWidgetCatalog(
  widgets: FloatWidgetState[],
  extensions: ExtensionInfo[],
): DesktopFloatingWidgetCatalogEntry[] {
  const extensionNames = new Map(
    extensions
      .filter((extension) => extension.enabled && extension.has_frontend)
      .map((extension) => [extension.id, extension.name]),
  )
  const positions = new Map<string, number>()

  return filterEnabledFrontendContributions(widgets, extensions)
    .filter((widget) => widget.visible)
    .map((widget) => {
      const index = positions.get(widget.extensionId) ?? 0
      positions.set(widget.extensionId, index + 1)
      const extensionName = extensionNames.get(widget.extensionId) ?? widget.extensionId
      const chromeless = widget.chromeless === true
      const minSize = desktopWidgetMinSize(chromeless)
      return {
        id: widget.id,
        extensionId: widget.extensionId,
        index,
        title: `${extensionName} · Widget ${index + 1}`,
        width: Math.max(minSize.width, Math.min(DESKTOP_WIDGET_MAX_SIZE.width, Math.round(widget.width))),
        height: Math.max(minSize.height, Math.min(DESKTOP_WIDGET_MAX_SIZE.height, Math.round(widget.height))),
        chromeless,
      }
    })
}

/** Publish only serializable widget metadata; the desktop host creates the
 * window and the new WebView loads the extension itself in widget mode. */
export function publishDesktopFloatingWidgetCatalog(entries: DesktopFloatingWidgetCatalogEntry[]): Promise<void> {
  if (!hasTauriDesktopBridge() || isDesktopFloatingWidgetWindow()) {
    return Promise.resolve()
  }
  return invoke('set_desktop_widget_catalog', { widgets: entries })
}

/** Keep a native child window's size and the primary frontend's placement
 * registry aligned. The command verifies the calling window owns widgetId. */
export function syncDesktopFloatingWidgetSize(widgetId: string, width: number, height: number): Promise<void> {
  if (!isDesktopFloatingWidgetWindow()) return Promise.resolve()
  return invoke('sync_desktop_widget_size', { widgetId, width, height })
}

export function resizeDesktopFloatingWidget(
  widgetId: string,
  width: number,
  height: number,
  chromeless: boolean,
): Promise<void> {
  if (!hasTauriDesktopBridge() || isDesktopFloatingWidgetWindow()) return Promise.resolve()
  const minSize = desktopWidgetMinSize(chromeless)
  return invoke('resize_extension_widget', {
    widgetId,
    width: Math.max(minSize.width, Math.min(DESKTOP_WIDGET_MAX_SIZE.width, Math.round(width))),
    height: Math.max(minSize.height, Math.min(DESKTOP_WIDGET_MAX_SIZE.height, Math.round(height))),
  })
}

/** Return the native pop-out to the main page. This is intentionally only
 * available to the owning widget WebView; the host validates that ownership. */
export function returnDesktopFloatingWidgetToPage(widgetId: string): Promise<void> {
  if (!isDesktopFloatingWidgetWindow()) return Promise.resolve()
  return invoke('return_extension_widget', { widgetId })
}
