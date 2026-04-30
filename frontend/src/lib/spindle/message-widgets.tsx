import { useEffect, useRef, useSyncExternalStore, type ReactElement } from 'react'
import { createSandboxFrame } from './sandbox-frame'

export interface SpindleMessageWidgetRenderOptions {
  messageId: string
  widgetId: string
  html: string
  minHeight?: number
  maxHeight?: number
}

interface MessageWidgetRecord extends SpindleMessageWidgetRenderOptions {
  extensionId: string
  onMessage?: (payload: unknown) => void
  corsProxy?: (url: string, options?: any) => Promise<any>
}

const widgetsByMessage = new Map<string, MessageWidgetRecord[]>()
const listeners = new Set<() => void>()
let version = 0

export function subscribeMessageWidgets(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getMessageWidgetVersion(): number {
  return version
}

export function upsertMessageWidget(
  extensionId: string,
  options: SpindleMessageWidgetRenderOptions,
  onMessage?: (payload: unknown) => void,
  corsProxy?: (url: string, options?: any) => Promise<any>,
): void {
  const list = widgetsByMessage.get(options.messageId) || []
  const nextRecord: MessageWidgetRecord = { ...options, extensionId, onMessage, corsProxy }
  const idx = list.findIndex((w) => w.extensionId === extensionId && w.widgetId === options.widgetId)
  if (idx === -1) list.push(nextRecord)
  else list[idx] = nextRecord
  widgetsByMessage.set(options.messageId, list)
  notify()
}

export function removeMessageWidget(extensionId: string, messageId: string, widgetId: string): void {
  const list = widgetsByMessage.get(messageId)
  if (!list) return
  const next = list.filter((w) => !(w.extensionId === extensionId && w.widgetId === widgetId))
  if (next.length === list.length) return
  if (next.length === 0) widgetsByMessage.delete(messageId)
  else widgetsByMessage.set(messageId, next)
  notify()
}

export function removeMessageWidgetsByExtension(extensionId: string): void {
  let changed = false
  for (const [messageId, list] of widgetsByMessage) {
    const next = list.filter((w) => w.extensionId !== extensionId)
    if (next.length === list.length) continue
    changed = true
    if (next.length === 0) widgetsByMessage.delete(messageId)
    else widgetsByMessage.set(messageId, next)
  }
  if (changed) notify()
}

export function SpindleMessageWidgets({ messageId }: { messageId?: string }): ReactElement | null {
  useSyncExternalStore(subscribeMessageWidgets, getMessageWidgetVersion, getMessageWidgetVersion)
  if (!messageId) return null
  const widgets = widgetsByMessage.get(messageId) || []
  if (widgets.length === 0) return null
  return (
    <>
      {widgets.map((widget) => (
        <MessageWidgetFrame key={`${widget.extensionId}:${widget.widgetId}`} widget={widget} />
      ))}
    </>
  )
}

function MessageWidgetFrame({ widget }: { widget: MessageWidgetRecord }): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const frame = createSandboxFrame(widget.extensionId, {
      html: widget.html,
      autoResize: true,
      minHeight: widget.minHeight ?? 40,
      maxHeight: widget.maxHeight ?? 4000,
    }, widget.corsProxy)
    frame.element.setAttribute('data-spindle-message-widget', widget.widgetId)
    frame.element.setAttribute('data-spindle-extension-id', widget.extensionId)
    frame.element.style.margin = '12px 0'
    const unsubscribe = frame.onMessage((payload) => widget.onMessage?.(payload))
    host.replaceChildren(frame.element)
    return () => {
      unsubscribe()
      frame.destroy()
      host.replaceChildren()
    }
  }, [widget])

  return <div ref={hostRef} data-spindle-message-widget-host={widget.widgetId} />
}

function notify(): void {
  version += 1
  for (const listener of listeners) {
    try { listener() } catch {}
  }
}
