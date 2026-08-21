import { EventType } from './events'
import { BASE_URL } from '@/api/client'

type EventHandler = (payload: any) => void

/** Internal client-only event names — not part of the backend protocol. */
export const WS_OPEN = '__ws_open'
export const WS_CLOSE = '__ws_close'
export const WS_PONG = '__ws_pong'
export const WS_AUTH_ERROR = '__ws_auth_error'
export const WS_RESUME_RECOVERY_START = '__ws_resume_recovery_start'
export const WS_RESUME_RECOVERY_COMPLETE = '__ws_resume_recovery_complete'
export const WS_RESUME_RECOVERY_FAILED = '__ws_resume_recovery_failed'

/** If we send a ping and don't see a pong within this window, treat the socket as dead. */
const PONG_TIMEOUT_MS = 10_000

/**
 * Shorter watchdog used when the page returns from hidden — iOS PWAs and some
 * desktop browsers silently kill the WS during suspension, and a snappier
 * foreground probe lets the recovery state resolve promptly on resume.
 */
const RESUME_PONG_TIMEOUT_MS = 3_000
const PING_INTERVAL_MS = 30_000
const RESUME_RECOVERY_TIMEOUT_MS = 20_000

type MobilePlatform = {
  userAgent: string
  platform: string
  maxTouchPoints: number
}

/**
 * iOS/iPadOS standalone apps are particularly aggressive about suspending
 * workers. Keep heartbeat scheduling on the main thread there; desktop and
 * Android browsers can safely use the worker timer.
 */
export function shouldUseHeartbeatWorker(platform: MobilePlatform = navigator): boolean {
  const isIOS = /iPad|iPhone|iPod/.test(platform.userAgent)
    || (platform.platform === 'MacIntel' && platform.maxTouchPoints > 1)
  return typeof Worker !== 'undefined' && !isIOS
}

type HeartbeatWorkerMessage =
  | { type: 'ping'; generation: number; timeoutMs: number; resumeProof?: boolean }
  | { type: 'timeout'; generation: number }

export class WebSocketClient {
  private ws: WebSocket | null = null
  private handlers = new Map<string, Set<EventHandler>>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatWorker: Worker | null = null
  private heartbeatWorkerUnavailable = false
  private heartbeatGeneration = 0
  private fallbackPingTimer: ReturnType<typeof setInterval> | null = null
  private fallbackPongWatchdog: ReturnType<typeof setTimeout> | null = null
  private url: string
  private shouldReconnect = true
  private spindleInfoLoggingEnabled = true
  private visibilityCleanup: Array<() => void> = []
  private focusedChatId: string | null = null
  /** Previous visibility state — used to detect hidden→visible transitions. */
  private wasVisible = false
  /** True while the document is hidden/frozen and JS liveness deadlines are unreliable. */
  private lifecyclePaused = false
  private resumeRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  /** The application-level pong that proves a *new* foreground round trip. */
  private resumeProbeId: string | null = null
  /**
   * One-shot suppression window for the aggressive resume watchdog. Used for
   * expected system-modal hops like the file picker, which can blur/hide the
   * page briefly and then return while a large upload is starting.
   */
  private suppressNextResumePingUntil = 0

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
      this.startVisibilityTracking()
      if (!this.lifecyclePaused) this.startPing()
      // If the old transport died while the PWA was suspended, this is the
      // first fresh socket of the resume recovery. Prove it explicitly rather
      // than accepting a delayed pong from the pre-suspension socket.
      if (this.resumeRecoveryTimer) this.sendPingNow(RESUME_PONG_TIMEOUT_MS, true)
      this.emit(WS_OPEN, {})
      this.emit(EventType.CONNECTED, {})
    }

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'pong') {
          this.ackHeartbeat()
          if (data.id && data.id === this.resumeProbeId) this.completeResumeRecovery()
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
        const isRoutineSpindleEvent = typeof eventName === 'string' && eventName.startsWith('SPINDLE_')
        if (
          eventName !== 'CONNECTED'
          && eventName !== 'STREAM_TOKEN_RECEIVED'
          && (!isRoutineSpindleEvent || this.spindleInfoLoggingEnabled)
        ) {
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

  /** Controls browser-console output for routine Spindle WebSocket events. */
  setSpindleInfoLogging(enabled: boolean): void {
    this.spindleInfoLoggingEnabled = enabled
  }

  disconnect() {
    this.shouldReconnect = false
    this.stopPing()
    this.stopVisibilityTracking()
    this.clearResumeRecovery()
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
    if (this.lifecyclePaused || !this.isDocumentVisible()) return
    this.stopPing()
    const generation = ++this.heartbeatGeneration
    if (this.ensureHeartbeatWorker()) {
      this.heartbeatWorker!.postMessage({
        type: 'start',
        generation,
        intervalMs: PING_INTERVAL_MS,
        timeoutMs: PONG_TIMEOUT_MS,
      })
      return
    }
    this.startFallbackHeartbeat(generation)
  }

  private stopPing() {
    const generation = ++this.heartbeatGeneration
    this.heartbeatWorker?.postMessage({ type: 'stop', generation })
    if (this.fallbackPingTimer) {
      clearInterval(this.fallbackPingTimer)
      this.fallbackPingTimer = null
    }
    this.clearFallbackPongWatchdog()
  }

  private sendPingNow(timeoutMs: number = PONG_TIMEOUT_MS, resumeProof = false) {
    if (this.lifecyclePaused || !this.isDocumentVisible()) return
    if (this.ensureHeartbeatWorker()) {
      this.heartbeatWorker!.postMessage({
        type: 'ping-now',
        generation: this.heartbeatGeneration,
        timeoutMs,
        resumeProof,
      })
      return
    }
    if (!this.sendPingFrame(resumeProof)) return
    this.armFallbackPongWatchdog(this.heartbeatGeneration, timeoutMs)
  }

  private sendPingFrame(resumeProof = false): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    try {
      const id = resumeProof ? crypto.randomUUID() : undefined
      if (id) this.resumeProbeId = id
      this.ws.send(JSON.stringify({ type: 'ping', ...(id ? { id } : {}) }))
      return true
    } catch {
      return false
    }
  }

  private ensureHeartbeatWorker(): boolean {
    if (this.heartbeatWorker) return true
    if (this.heartbeatWorkerUnavailable || !shouldUseHeartbeatWorker()) return false

    try {
      const worker = new Worker(new URL('./heartbeat.worker.ts', import.meta.url), {
        type: 'module',
        name: 'lumiverse-heartbeat',
      })
      worker.onmessage = (event: MessageEvent<HeartbeatWorkerMessage>) => {
        const message = event.data
        if (message.generation !== this.heartbeatGeneration) return
        if (message.type === 'ping') {
          if (this.sendPingFrame(message.resumeProof)) {
            worker.postMessage({
              type: 'arm',
              generation: message.generation,
              timeoutMs: message.timeoutMs,
            })
          }
        } else if (message.type === 'timeout') {
          this.handleHeartbeatTimeout(message.generation)
        }
      }
      worker.onerror = (event) => {
        console.warn('[WS] Heartbeat worker failed; using main-thread fallback:', event.message)
        worker.terminate()
        if (this.heartbeatWorker === worker) this.heartbeatWorker = null
        this.heartbeatWorkerUnavailable = true
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.startFallbackHeartbeat(this.heartbeatGeneration)
        }
      }
      this.heartbeatWorker = worker
      return true
    } catch (error) {
      console.warn('[WS] Heartbeat worker unavailable; using main-thread fallback:', error)
      this.heartbeatWorkerUnavailable = true
      return false
    }
  }

  private startFallbackHeartbeat(generation: number): void {
    if (this.fallbackPingTimer) clearInterval(this.fallbackPingTimer)
    this.fallbackPingTimer = setInterval(() => {
      if (generation !== this.heartbeatGeneration || !this.sendPingFrame()) return
      this.armFallbackPongWatchdog(generation, PONG_TIMEOUT_MS)
    }, PING_INTERVAL_MS)
  }

  private armFallbackPongWatchdog(generation: number, timeoutMs: number): void {
    this.clearFallbackPongWatchdog()
    this.fallbackPongWatchdog = setTimeout(() => {
      this.fallbackPongWatchdog = null
      this.handleHeartbeatTimeout(generation)
    }, timeoutMs)
  }

  private clearFallbackPongWatchdog(): void {
    if (this.fallbackPongWatchdog) {
      clearTimeout(this.fallbackPongWatchdog)
      this.fallbackPongWatchdog = null
    }
  }

  private ackHeartbeat(): void {
    this.clearFallbackPongWatchdog()
    this.heartbeatWorker?.postMessage({
      type: 'ack',
      generation: this.heartbeatGeneration,
    })
  }

  private handleHeartbeatTimeout(generation: number): void {
    if (generation !== this.heartbeatGeneration) return
    // A deadline created before a PWA/tab suspension is not evidence of a
    // dead server. Lifecycle handlers invalidate timers before suspension,
    // but this guard also covers an already-queued worker message on resume.
    if (this.lifecyclePaused || !this.isDocumentVisible()) return
    console.warn('[WS] Pong timeout — forcing close to trigger reconnect')
    const socket = this.ws
    if (!socket) return

    // Do not wait for the browser's close handshake: a half-open connection can
    // remain CLOSING for an unbounded period. Detach it first so its eventual
    // onclose is ignored, then drive the normal UI/reconnect state ourselves.
    this.stopPing()
    this.ws = null
    try {
      socket.close()
    } catch {
      /* noop */
    }
    this.emit(WS_CLOSE, { code: 1006, reason: 'heartbeat timeout' })
    if (this.shouldReconnect) this.scheduleReconnect()
  }

  /** Send a ping immediately and arm the pong watchdog. Used after CONNECTED to verify round-trip. */
  forcePing() {
    this.sendPingNow()
  }

  /**
   * Suppress the next hidden→visible fast-ping if it happens within the
   * provided window. This avoids false reconnects around expected system UI
   * transitions such as opening a file picker before a large upload.
   */
  suppressNextResumePingFor(ms: number = 120_000) {
    const durationMs = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0
    if (durationMs <= 0) {
      this.suppressNextResumePingUntil = 0
      return
    }
    this.suppressNextResumePingUntil = Math.max(
      this.suppressNextResumePingUntil,
      Date.now() + durationMs,
    )
  }

  private visibilityHandler: (() => void) | null = null

  private startVisibilityTracking() {
    this.stopVisibilityTracking()

    // Seed wasVisible with the current state so the first sendVisibility()
    // doesn't fire a spurious resume-check ping. onopen → forcePing already
    // verifies round-trip for the initial connection.
    this.wasVisible = this.isDocumentVisible()
    this.lifecyclePaused = !this.wasVisible

    const onVisibilityChange = () => {
      if (this.isDocumentVisible()) this.resumeFromBackground()
      else {
        this.pauseForBackground()
        this.sendVisibility()
      }
    }
    const onFocusChange = () => this.sendVisibility()
    this.visibilityHandler = onVisibilityChange

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
    addListener(document, 'visibilitychange', onVisibilityChange)
    addListener(window, 'focus', onFocusChange)
    addListener(window, 'blur', onFocusChange)
    addListener(window, 'pageshow', () => this.resumeFromBackground())
    addListener(window, 'pagehide', () => {
      this.pauseForBackground()
      this.sendVisibility(true)
    })
    // Chrome's Page Lifecycle API gives an extra, earlier opportunity to
    // disarm liveness timers before a document is frozen or bfcached.
    addListener(document, 'freeze', () => this.pauseForBackground())
    addListener(document, 'resume', () => this.resumeFromBackground())
    addListener(window, 'beforeunload', () => {
      this.pauseForBackground()
      this.sendVisibility(true)
    })
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
      if (!this.consumeResumePingSuppression()) {
        this.sendPingNow(RESUME_PONG_TIMEOUT_MS, this.resumeRecoveryTimer !== null)
      } else if (this.resumeRecoveryTimer) {
        // A caller has explicitly told us this return is an expected system
        // modal hop (for example a file picker), so retain the known-good
        // transport rather than timing it out with no fresh probe.
        this.completeResumeRecovery()
      }
    }
    this.wasVisible = visible
  }

  private consumeResumePingSuppression() {
    const suppressUntil = this.suppressNextResumePingUntil
    if (suppressUntil <= 0) return false
    if (Date.now() >= suppressUntil) {
      this.suppressNextResumePingUntil = 0
      return false
    }
    this.suppressNextResumePingUntil = 0
    return true
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
    const chatId = !forceHidden && this.isDocumentFocused() ? this.focusedChatId : null
    this.send({ type: 'stream_focus', chatId })
  }

  private isDocumentVisible() {
    return document.visibilityState === 'visible'
  }

  private isDocumentFocused() {
    return this.isDocumentVisible() && document.hasFocus()
  }

  private pauseForBackground() {
    if (this.lifecyclePaused) return
    this.lifecyclePaused = true
    this.wasVisible = false
    this.stopPing()
  }

  private resumeFromBackground() {
    if (!this.isDocumentVisible()) return
    const wasPaused = this.lifecyclePaused
    this.lifecyclePaused = false
    if (wasPaused) this.beginResumeRecovery()
    this.startPing()
    this.sendVisibility()
  }

  private beginResumeRecovery() {
    this.clearResumeRecovery()
    this.emit(WS_RESUME_RECOVERY_START, {})
    this.resumeRecoveryTimer = setTimeout(() => {
      this.resumeRecoveryTimer = null
      this.resumeProbeId = null
      this.emit(WS_RESUME_RECOVERY_FAILED, {})
    }, RESUME_RECOVERY_TIMEOUT_MS)
  }

  private completeResumeRecovery() {
    if (!this.resumeRecoveryTimer) return
    this.clearResumeRecovery()
    this.emit(WS_RESUME_RECOVERY_COMPLETE, {})
  }

  private clearResumeRecovery() {
    if (this.resumeRecoveryTimer) {
      clearTimeout(this.resumeRecoveryTimer)
      this.resumeRecoveryTimer = null
    }
    this.resumeProbeId = null
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
