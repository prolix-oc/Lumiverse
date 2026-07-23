import { invoke } from '@tauri-apps/api/core'
import type { FloatWidgetState } from '@/store/slices/spindle-placement'
import type { ExtensionInfo } from 'lumiverse-spindle-types'

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

function readTarget(): DesktopFloatingWidgetTarget | null {
  if (!('__TAURI_INTERNALS__' in window)) return null

  const params = new URLSearchParams(window.location.search)
  const extensionId = params.get('desktopWidgetExtension')
  const index = Number(params.get('desktopWidgetIndex') ?? '0')
  const title = params.get('desktopWidgetTitle')
  const width = Number(params.get('desktopWidgetWidth'))
  const height = Number(params.get('desktopWidgetHeight'))
  if (
    !extensionId ||
    extensionId.length > 200 ||
    !Number.isInteger(index) ||
    index < 0 ||
    index > 3 ||
    !Number.isInteger(width) ||
    width < 160 ||
    width > 1200 ||
    !Number.isInteger(height) ||
    height < 100 ||
    height > 900
  ) {
    return null
  }
  return {
    extensionId,
    index,
    title: title?.slice(0, 120) || 'Extension widget',
    chromeless: params.get('desktopWidgetChromeless') === '1',
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
  const extensionNames = new Map(extensions.map((extension) => [extension.id, extension.name]))
  const positions = new Map<string, number>()

  return widgets
    .filter((widget) => widget.visible)
    .map((widget) => {
      const index = positions.get(widget.extensionId) ?? 0
      positions.set(widget.extensionId, index + 1)
      const extensionName = extensionNames.get(widget.extensionId) ?? widget.extensionId
      return {
        id: widget.id,
        extensionId: widget.extensionId,
        index,
        title: `${extensionName} · Widget ${index + 1}`,
        width: Math.max(160, Math.min(1200, Math.round(widget.width))),
        height: Math.max(100, Math.min(900, Math.round(widget.height))),
        chromeless: widget.chromeless === true,
      }
    })
}

/** Publish only serializable widget metadata; the desktop host creates the
 * window and the new WebView loads the extension itself in widget mode. */
export function publishDesktopFloatingWidgetCatalog(entries: DesktopFloatingWidgetCatalogEntry[]): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window) || isDesktopFloatingWidgetWindow()) {
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

export function resizeDesktopFloatingWidget(widgetId: string, width: number, height: number): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window) || isDesktopFloatingWidgetWindow()) return Promise.resolve()
  return invoke('resize_extension_widget', {
    widgetId,
    width: Math.max(160, Math.min(1200, Math.round(width))),
    height: Math.max(100, Math.min(900, Math.round(height))),
  })
}

/** Return the native pop-out to the main page. This is intentionally only
 * available to the owning widget WebView; the host validates that ownership. */
export function returnDesktopFloatingWidgetToPage(widgetId: string): Promise<void> {
  if (!isDesktopFloatingWidgetWindow()) return Promise.resolve()
  return invoke('return_extension_widget', { widgetId })
}
