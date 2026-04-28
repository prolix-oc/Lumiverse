import { EventType } from './events'
import { BASE_URL } from '@/api/client'

type EventHandler = (payload: any) => void

export class WebSocketClient {
  private ws: WebSocket | null = null
  private handlers = new Map<string, Set<EventHandler>>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private url: string
  private shouldReconnect = true
  private visibilityCleanup: Array<() => void> = []
  private focusedChatId: string | null = null

  constructor(url?: string) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    // Derive WS path from API base (e.g. /api/v1 -> /api/ws)
    const basePath = BASE_URL.replace(/\/v\d+$/, '')
    this.url = url || `${protocol}//${window.location.host}${basePath}/ws`
  }

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return

    this.shouldReconnect = true
    // Cancel any pending reconnect — we're connecting now
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws = new WebSocket(this.url)

    this.ws.onopen = () => {
      console.log('[WS] Connected to', this.url)
      // Cancel any stale reconnect timer from a prior socket's onclose
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
      this.startPing()
      this.startVisibilityTracking()
      this.emit(EventType.CONNECTED, {})
    }

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'pong') return
        if (data.event === 'AUTH_ERROR') {
          console.warn('[WS] Auth error — will not reconnect')
          this.shouldReconnect = false
          return
        }
        const eventName = data.event || data.type
        if (eventName !== 'CONNECTED' && eventName !== 'STREAM_TOKEN_RECEIVED') {
          console.debug('[WS] ←', eventName, data.payload)
        }
        this.emit(eventName, data.payload)
      } catch {
        // ignore malformed messages
      }
    }

    const thisSocket = this.ws
    this.ws.onclose = (e) => {
      console.log('[WS] Closed:', e.code, e.reason)
      this.stopPing()
      // Only reconnect if this is still the active socket — a newer socket
      // may have already replaced us (e.g. server-side session eviction).
      if (this.shouldReconnect && this.ws === thisSocket) {
        this.scheduleReconnect()
      }
    }

    this.ws.onerror = (e) => {
      console.error('[WS] Error:', e)
    }
  }

  disconnect() {
    this.shouldReconnect = false
    this.stopPing()
    this.stopVisibilityTracking()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  on(event: string, handler: EventHandler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set())
    }
    this.handlers.get(event)!.add(handler)
    return () => {
      this.handlers.get(event)?.delete(handler)
    }
  }

  private emit(event: string, payload: any) {
    this.handlers.get(event)?.forEach(handler => {
      try {
        handler(payload)
      } catch (err) {
        console.error(`[WS] Error in handler for ${event}:`, err)
      }
    })
  }

  private startPing() {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }))
      }
    }, 30000)
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private visibilityHandler: (() => void) | null = null

  private startVisibilityTracking() {
    this.stopVisibilityTracking()

    const handler = () => this.sendVisibility()
    this.visibilityHandler = handler

    const addListener = (
      target: Document | Window,
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) => {
      target.addEventListener(type, listener)
      this.visibilityCleanup.push(() => target.removeEventListener(type, listener))
    }

    // Send current state immediately on connect, then refresh it from every
    // lifecycle event that commonly fires during backgrounding/suspension.
    this.sendVisibility()
    addListener(document, 'visibilitychange', handler)
    addListener(window, 'focus', handler)
    addListener(window, 'blur', handler)
    addListener(window, 'pageshow', handler)
    addListener(window, 'pagehide', () => this.sendVisibility(true))
    addListener(window, 'beforeunload', () => this.sendVisibility(true))
  }

  private stopVisibilityTracking() {
    for (const cleanup of this.visibilityCleanup) cleanup()
    this.visibilityCleanup = []
    this.visibilityHandler = null
  }

  private sendVisibility(forceHidden = false) {
    const visible = !forceHidden && this.isDocumentVisible()
    this.send({ type: 'visibility', visible })
    this.sendStreamFocus(forceHidden)
  }

  private sendStreamFocus(forceHidden = false) {
    const chatId = !forceHidden && this.isDocumentVisible() ? this.focusedChatId : null
    this.send({ type: 'stream_focus', chatId })
  }

  private isDocumentVisible() {
    return document.visibilityState === 'visible' && document.hasFocus()
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 3000)
  }

  send(data: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  setFocusedChat(chatId: string | null): void {
    this.focusedChatId = chatId
    this.sendStreamFocus()
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN
  }
}

export const wsClient = new WebSocketClient()
