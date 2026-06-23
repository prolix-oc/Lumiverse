import { EventType } from './events'
import { BASE_URL } from '@/api/client'

type EventHandler = (payload: any) => void

/** Internal client-only event names — not part of the backend protocol. */
export const WS_OPEN = '__ws_open'
export const WS_CLOSE = '__ws_close'
export const WS_PONG = '__ws_pong'
export const WS_AUTH_ERROR = '__ws_auth_error'

/** If we send a ping and don't see a pong within this window, treat the socket as dead. */
const PONG_TIMEOUT_MS = 10_000

/**
 * Shorter watchdog used when the page returns from hidden — iOS PWAs and some
 * desktop browsers silently kill the WS during suspension, and a snappier
 * timeout here keeps the connection-lost overlay's grace window from
 * overflowing on resume.
 */
const RESUME_PONG_TIMEOUT_MS = 3_000

export class WebSocketClient {
  private ws: WebSocket | null = null
  private handlers = new Map<string, Set<EventHandler>>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pongWatchdog: ReturnType<typeof setTimeout> | null = null
  private url: string
  private shouldReconnect = true
  private visibilityCleanup: Array<() => void> = []
  private focusedChatId: string | null = null
  /** Previous visibility state — used to detect hidden→visible transitions. */
  private wasVisible = false

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
      this.emit(WS_OPEN, {})
      this.emit(EventType.CONNECTED, {})
    }

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'pong') {
          this.clearPongWatchdog()
          this.emit(WS_PONG, {})
          return
        }
        if (data.event === 'AUTH_ERROR') {
          console.warn('[WS] Auth error — will not reconnect')
          this.shouldReconnect = false
          this.emit(WS_AUTH_ERROR, data.payload ?? {})
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
      if (this.ws !== thisSocket) return
      this.stopPing()
      this.emit(WS_CLOSE, { code: e.code, reason: e.reason })
      if (this.shouldReconnect) {
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

  /**
   * Dispatch an event through the same handler registry as the live socket.
   * Used by the relay client so events arriving over the Identity Server relay
   * (for a remote peer) flow through the exact same store handlers.
   */
  dispatchExternal(event: string, payload: any) {
    this.emit(event, payload)
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
      this.sendPingNow()
    }, 30000)
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    this.clearPongWatchdog()
  }

  private sendPingNow(timeoutMs: number = PONG_TIMEOUT_MS) {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ type: 'ping' }))
    this.armPongWatchdog(timeoutMs)
  }

  private armPongWatchdog(timeoutMs: number = PONG_TIMEOUT_MS) {
    this.clearPongWatchdog()
    this.pongWatchdog = setTimeout(() => {
      this.pongWatchdog = null
      console.warn('[WS] Pong timeout — forcing close to trigger reconnect')
      // Force-close the socket. onclose will fire, which both emits WS_CLOSE
      // (so the UI shows the overlay) and triggers the standard reconnect path.
      try {
        this.ws?.close()
      } catch {
        /* noop */
      }
    }, timeoutMs)
  }

  private clearPongWatchdog() {
    if (this.pongWatchdog) {
      clearTimeout(this.pongWatchdog)
      this.pongWatchdog = null
    }
  }

  /** Send a ping immediately and arm the pong watchdog. Used after CONNECTED to verify round-trip. */
  forcePing() {
    this.sendPingNow()
  }

  private visibilityHandler: (() => void) | null = null

  private startVisibilityTracking() {
    this.stopVisibilityTracking()

    // Seed wasVisible with the current state so the first sendVisibility()
    // doesn't fire a spurious resume-check ping. onopen → forcePing already
    // verifies round-trip for the initial connection.
    this.wasVisible = this.isDocumentVisible()

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
    if (this.recoverIfSocketAlreadyClosed()) {
      this.wasVisible = visible
      return
    }
    this.send({ type: 'visibility', visible })
    this.sendStreamFocus(forceHidden)
    // Hidden→visible transition: iOS aggressively kills WS in suspended PWAs.
    // Send a fast-watchdog ping so we detect a dead socket within ~3s, instead
    // of waiting up to a full 30s ping window before noticing.
    if (visible && !this.wasVisible) {
      this.sendPingNow(RESUME_PONG_TIMEOUT_MS)
    }
    this.wasVisible = visible
  }

  private recoverIfSocketAlreadyClosed() {
    const socket = this.ws
    if (!socket) return false
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) return false

    // Some browsers defer onclose while a tab/app is suspended. When lifecycle
    // events resume, the socket may already be CLOSED, which makes pings no-op
    // unless we explicitly drive the normal close/reconnect path here.
    console.warn('[WS] Socket was closed before onclose fired — reconnecting')
    this.stopPing()
    this.ws = null
    this.emit(WS_CLOSE, { code: 1006, reason: 'stale socket detected' })
    if (this.shouldReconnect) this.scheduleReconnect()
    return true
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
