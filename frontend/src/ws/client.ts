import { invalidateSharedReads } from '@/lib/shared-read'
import { activeTab } from '@/lib/active-tab'
import { uuidv4 } from '@/lib/uuid'
import { EventType } from './events'
import { BASE_URL } from '@/api/client'
import { frontendSessionId } from '@/lib/frontend-session'
import { getIOSAppState, subscribeIOSAppState, type IOSAppState } from '@/lib/ios-app-state'
import {
  getDesktopPresence,
  subscribeDesktopPresence,
  type DesktopPresence,
} from '@/lib/desktop-presence'

export interface EventMetadata { stateRevision?: { epoch: string; sequence: number }; runtimeMutationId?: string }
type EventHandler = (payload: any, metadata?: EventMetadata) => void

/** Internal client-only event names — not part of the backend protocol. */
export const WS_OPEN = '__ws_open'
export const WS_CLOSE = '__ws_close'
export const WS_PONG = '__ws_pong'
export const WS_AUTH_ERROR = '__ws_auth_error'
export const WS_RESUME_RECOVERY_START = '__ws_resume_recovery_start'
export const WS_RESUME_RECOVERY_COMPLETE = '__ws_resume_recovery_complete'
export const WS_RESUME_RECOVERY_FAILED = '__ws_resume_recovery_failed'

/** If we send a ping and don't see a pong within this window, treat the socket as dead. */
const PONG_TIMEOUT_MS = 15_000

/**
 * Shorter watchdog used when the page returns from hidden — iOS PWAs and some
 * desktop browsers silently kill the WS during suspension, and a snappier
 * foreground probe lets the recovery state resolve promptly on resume. Keep
 * this generous enough for WebKit/Android to restore networking and drain the
 * main-thread queue before declaring a healthy socket dead.
 */
const RESUME_PONG_TIMEOUT_MS = 15_000
const PING_INTERVAL_MS = 30_000
const CONNECT_TIMEOUT_MS = 15_000
const RESUME_RECOVERY_TIMEOUT_MS = 30_000
const RESUME_RECONNECT_SETTLE_MS = 250
const INITIAL_RECONNECT_MS = 3_000
const MAX_RECONNECT_MS = 30_000
const RECONNECT_JITTER_MS = 1_000
const WAKE_CHECK_INTERVAL_MS = 5_000
const WAKE_GAP_MS = 15_000

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
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private heartbeatWorker: Worker | null = null
  private heartbeatWorkerUnavailable = false
  private heartbeatGeneration = 0
  private fallbackPingTimer: ReturnType<typeof setInterval> | null = null
  private fallbackPongWatchdog: ReturnType<typeof setTimeout> | null = null
  private url: string
  private shouldReconnect = true
  private spindleInfoLoggingEnabled = true
  private visibilityCleanup: Array<() => void> = []
  private desktopPresence: DesktopPresence | null = null
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
  /** Timer-gap fallback for mobile WebViews that omit lifecycle events. */
  private lastLifecycleTick = Date.now()

  constructor(url?: string) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    // Derive WS path from API base (e.g. /api/v1 -> /api/ws)
    const basePath = BASE_URL.replace(/\/v\d+$/, '')
    this.url = url || `${protocol}//${window.location.host}${basePath}/ws`
  }

  private executionOwner = true

  connect(options?: { executionOwner?: boolean }) {
    if (activeTab.signal.aborted) return
    if (options?.executionOwner !== undefined) this.executionOwner = options.executionOwner
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return

    this.shouldReconnect = true
    // Cancel any pending reconnect — we're connecting now
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const socketUrl = new URL(this.url)
    socketUrl.searchParams.set('frontend_session', frontendSessionId)
    if (!this.executionOwner) socketUrl.searchParams.set('frontend_runtime', 'widget')
    const socket = new WebSocket(socketUrl.toString())
    this.ws = socket
    this.armConnectWatchdog(socket)
    // Install lifecycle listeners while CONNECTING too. Otherwise an initial
    // handshake suspended before onopen could time out in the background and
    // have no foreground event left to restart it.
    this.startVisibilityTracking()

    socket.onopen = () => {
      if (this.ws !== socket) return
      this.clearConnectWatchdog()
      console.log('[WS] Connected to', this.url)
      // Cancel any stale reconnect timer from a prior socket's onclose
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
      if (!this.lifecyclePaused) this.startPing()
      // Tracking starts during CONNECTING, when send() drops frames. Publish
      // the current state once this transport can actually carry it.
      this.sendVisibility(this.lifecyclePaused)
      // If the old transport died while the PWA was suspended, this is the
      // first fresh socket of the resume recovery. Prove it explicitly rather
      // than accepting a delayed pong from the pre-suspension socket.
      if (this.resumeRecoveryTimer) this.sendPingNow(RESUME_PONG_TIMEOUT_MS, true)
      this.emit(WS_OPEN, {})
      this.emit(EventType.CONNECTED, {})
    }

    socket.onmessage = (event) => {
      if (this.ws !== socket) return
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
        // The backend registers presence only after async authentication.
        // Replay on its acknowledgement before application handlers run.
        if (eventName === EventType.CONNECTED) this.sendVisibility(this.lifecyclePaused)
        if (
          this.spindleInfoLoggingEnabled
          && eventName !== 'CONNECTED'
          && eventName !== 'STREAM_TOKEN_RECEIVED'
        ) {
          console.debug('[WS] ←', eventName, data.payload)
        }
        this.emit(eventName, data.payload, { stateRevision: data.stateRevision, runtimeMutationId: data.runtimeMutationId })
      } catch {
        // ignore malformed messages
      }
    }

    socket.onclose = (e) => {
      console.log('[WS] Closed:', e.code, e.reason)
      if (this.ws !== socket) return
      this.clearConnectWatchdog()
      this.ws = null
      this.stopPing()
      this.emit(WS_CLOSE, { code: e.code, reason: e.reason })
      if (this.shouldReconnect) {
        this.scheduleReconnect(this.resumeRecoveryTimer !== null)
      }
    }

    socket.onerror = (e) => {
      if (this.ws !== socket) return
      console.error('[WS] Error:', e)
    }
  }

  private armConnectWatchdog(socket: WebSocket): void {
    this.clearConnectWatchdog()
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null
      if (this.ws !== socket || socket.readyState !== WebSocket.CONNECTING) return
      console.warn('[WS] Connection handshake timed out — reconnecting')
      this.abandonSocket(socket)
      this.emit(WS_CLOSE, { code: 1006, reason: 'connection timeout' })
      if (this.shouldReconnect) this.scheduleReconnect(this.resumeRecoveryTimer !== null)
    }, CONNECT_TIMEOUT_MS)
  }

  private clearConnectWatchdog(): void {
    if (!this.connectTimer) return
    clearTimeout(this.connectTimer)
    this.connectTimer = null
  }

  /** Detach a stale transport before closing so delayed events cannot mutate current state. */
  private abandonSocket(socket: WebSocket): void {
    if (this.ws === socket) this.ws = null
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    try {
      socket.close()
    } catch {
      /* noop */
    }
  }

  /** Controls browser-console output for routine inbound WebSocket events. */
  setSpindleInfoLogging(enabled: boolean): void {
    this.spindleInfoLoggingEnabled = enabled
  }

  disconnect() {
    this.shouldReconnect = false
    this.stopPing()
    this.stopVisibilityTracking()
    this.clearResumeRecovery()
    this.clearConnectWatchdog()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.abandonSocket(this.ws)
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

  private emit(event: string, payload: any, metadata?: EventMetadata) {
    if (event === EventType.CONNECTED || /(?:CHANGED|DELETED|EDITED|CREATED|UPDATED|MESSAGE_SENT|GENERATION_ENDED)$/.test(event)) invalidateSharedReads()
    this.handlers.get(event)?.forEach(handler => {
      try {
        handler(payload, metadata)
      } catch (err) {
        console.error(`[WS] Error in handler for ${event}:`, err)
      }
    })
  }

  private startPing() {
    if (this.lifecyclePaused || (!this.isDocumentVisible() && !this.keepsAndroidConnection())) return
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
      const id = resumeProof ? uuidv4() : undefined
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
    this.reconnectAttempts = 0
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
    this.abandonSocket(socket)
    this.emit(WS_CLOSE, { code: 1006, reason: 'heartbeat timeout' })
    if (this.shouldReconnect) this.scheduleReconnect(this.resumeRecoveryTimer !== null)
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
    this.lifecyclePaused = !this.wasVisible && !this.keepsAndroidConnection()

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

    // Track lifecycle changes even during CONNECTING. onopen and the server's
    // CONNECTED acknowledgement publish the latest state on the new socket.
    addListener(document, 'visibilitychange', onVisibilityChange)
    addListener(window, 'focus', () => {
      this.recoverConnectionOnForeground('focus')
      onFocusChange()
    })
    addListener(window, 'blur', onFocusChange)
    addListener(window, 'pageshow', () => this.recoverConnectionOnForeground('pageshow'))
    addListener(window, 'pagehide', () => {
      this.pauseForBackground()
      this.sendVisibility(true)
      this.suspendTransport('page hidden')
    })
    // Chrome's Page Lifecycle API gives an extra, earlier opportunity to
    // disarm liveness timers before a document is frozen or bfcached.
    addListener(document, 'freeze', () => {
      this.pauseForBackground()
      this.suspendTransport('page frozen')
    })
    addListener(document, 'resume', () => this.recoverConnectionOnForeground('resume'))
    addListener(window, 'online', () => this.recoverConnectionOnForeground('online'))
    addListener(window, 'offline', () => {
      if (!this.isDocumentVisible()) return
      this.beginResumeRecovery()
      this.sendPingNow(PONG_TIMEOUT_MS, true)
    })
    addListener(window, 'beforeunload', () => {
      this.pauseForBackground()
      this.sendVisibility(true)
    })
    this.visibilityCleanup.push(subscribeIOSAppState(state => this.applyIOSAppState(state)))
    addListener(window, 'lumiverse:android-app-state', event => {
      const state = (event as CustomEvent<{ state?: IOSAppState }>).detail?.state
      if (state === 'active' || state === 'background') this.applyIOSAppState(state)
    })
    let desktopPresenceUnlisten: (() => void) | null = null
    let desktopPresenceStopped = false
    void subscribeDesktopPresence((presence) => {
      if (desktopPresenceStopped) return
      this.applyDesktopPresence(presence)
    }).then((unlisten) => {
      if (desktopPresenceStopped) unlisten()
      else desktopPresenceUnlisten = unlisten
    }).catch((error) => {
      console.warn('[desktop-presence] Could not subscribe to native window state', error)
    })
    this.visibilityCleanup.push(() => {
      desktopPresenceStopped = true
      desktopPresenceUnlisten?.()
      desktopPresenceUnlisten = null
      this.desktopPresence = null
    })
    this.lastLifecycleTick = Date.now()
    const wakeCheckTimer = setInterval(() => this.checkForWakeGap(), WAKE_CHECK_INTERVAL_MS)
    this.visibilityCleanup.push(() => clearInterval(wakeCheckTimer))
  }

  private stopVisibilityTracking() {
    for (const cleanup of this.visibilityCleanup) cleanup()
    this.visibilityCleanup = []
    this.visibilityHandler = null
  }

  private sendVisibility(forceHidden = false) {
    const pageVisible = !forceHidden && this.isDocumentVisible()
    const desktopPresence = this.desktopPresence ?? getDesktopPresence()
    const visible = pageVisible && this.isDocumentFocused()
    if (this.recoverIfSocketAlreadyClosed()) {
      this.wasVisible = pageVisible
      return
    }
    this.send({
      type: 'visibility',
      visible,
      ...(desktopPresence ? {
        source: 'tauri',
        state: desktopPresence.state,
        windowVisible: desktopPresence.visible,
        minimized: desktopPresence.minimized,
        focused: desktopPresence.focused,
      } : {}),
    })
    this.sendStreamFocus(forceHidden)
    // Hidden→visible transition: iOS aggressively kills WS in suspended PWAs.
    // Send a foreground proof ping instead of waiting for the next scheduled
    // heartbeat. Its deadline is deliberately patient while mobile networking
    // and the JavaScript event queues settle after suspension.
    if (pageVisible && !this.wasVisible) {
      if (!this.consumeResumePingSuppression()) {
        this.sendPingNow(RESUME_PONG_TIMEOUT_MS, this.resumeRecoveryTimer !== null)
      } else if (this.resumeRecoveryTimer) {
        // A caller has explicitly told us this return is an expected system
        // modal hop (for example a file picker), so retain the known-good
        // transport rather than timing it out with no fresh probe.
        this.completeResumeRecovery()
      }
    }
    this.wasVisible = pageVisible
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
    this.clearConnectWatchdog()
    this.abandonSocket(socket)
    this.emit(WS_CLOSE, { code: 1006, reason: 'stale socket detected' })
    if (this.shouldReconnect) this.scheduleReconnect(true)
    return true
  }

  private sendStreamFocus(forceHidden = false) {
    const chatId = ((!forceHidden && this.isDocumentFocused()) || this.keepsAndroidConnection()) ? this.focusedChatId : null
    this.send({ type: 'stream_focus', chatId })
  }

  /**
   * Tauri's native window state is authoritative for its embedded WebView.
   * WebView2 can leave Page Visibility stale around native hide/show and focus
   * transitions; treating that stale value as an additional requirement makes
   * an actually foreground window unsubscribe from live stream tokens. The
   * generation-pool watchdog then becomes the only update path, which presents
   * the stream as multi-second chunks.
   */
  private applyDesktopPresence(presence: DesktopPresence) {
    this.desktopPresence = presence
    if (this.isDocumentVisible()) {
      if (this.lifecyclePaused) this.resumeFromBackground()
      else this.sendVisibility()
      return
    }
    this.pauseForBackground()
    this.sendVisibility()
  }

  private applyIOSAppState(state: IOSAppState) {
    if (state !== 'active') {
      this.pauseForBackground()
      this.sendVisibility(true)
      return
    }
    // Always prove this foreground round trip, even if the background event
    // never reached the suspended JS context or the switch took <15 seconds.
    this.beginResumeRecovery()
    this.wasVisible = false
    this.resumeFromBackground()
  }

  private isDocumentVisible() {
    const androidActive = (window as Window & { __LUMIVERSE_ANDROID_ACTIVE__?: boolean }).__LUMIVERSE_ANDROID_ACTIVE__
    if (androidActive !== undefined) return androidActive
    const iosAppState = getIOSAppState()
    if (iosAppState) return iosAppState === 'active'
    const desktopPresence = this.desktopPresence ?? getDesktopPresence()
    if (desktopPresence) return desktopPresence.visible && !desktopPresence.minimized
    return document.visibilityState === 'visible'
  }

  private isDocumentFocused() {
    const androidActive = (window as Window & { __LUMIVERSE_ANDROID_ACTIVE__?: boolean }).__LUMIVERSE_ANDROID_ACTIVE__
    if (androidActive !== undefined) return androidActive
    const iosAppState = getIOSAppState()
    if (iosAppState) return iosAppState === 'active'
    const desktopPresence = this.desktopPresence ?? getDesktopPresence()
    if (desktopPresence) return desktopPresence.active
    return this.isDocumentVisible() && document.hasFocus()
  }

  /** The new Android wrapper protects JS with a foreground service and wake lock.
   * Presence remains hidden, but token subscriptions and liveness must continue for TTS. */
  private keepsAndroidConnection() {
    return (window as Window & { __LUMIVERSE_ANDROID_BACKGROUND_CONNECTION__?: boolean })
      .__LUMIVERSE_ANDROID_BACKGROUND_CONNECTION__ === true
  }

  private pauseForBackground() {
    if (this.keepsAndroidConnection()) {
      this.lifecyclePaused = false
      this.startPing()
      return
    }
    if (this.lifecyclePaused) return
    this.lifecyclePaused = true
    this.wasVisible = false
    this.stopPing()
  }

  /**
   * Chrome explicitly recommends releasing WebSockets when a page is frozen.
   * pagehide covers bfcache and the equivalent WebKit lifecycle path. A plain
   * visibility change intentionally keeps the transport and probes it later.
   */
  private suspendTransport(reason: string) {
    const socket = this.ws
    if (!socket) return
    this.clearConnectWatchdog()
    this.abandonSocket(socket)
    this.emit(WS_CLOSE, { code: 1001, reason })
  }

  private resumeFromBackground() {
    if (!this.isDocumentVisible()) return
    const wasPaused = this.lifecyclePaused
    this.lifecyclePaused = false
    if (wasPaused || this.ws?.readyState !== WebSocket.OPEN) this.beginResumeRecovery()
    if (!this.ws) {
      if (this.shouldReconnect) this.scheduleReconnect(true)
      return
    }
    this.startPing()
    this.sendVisibility()
  }

  private recoverConnectionOnForeground(_source: string) {
    if (!this.isDocumentVisible()) return
    if (!this.lifecyclePaused && this.ws?.readyState === WebSocket.OPEN) return
    this.resumeFromBackground()
  }

  private checkForWakeGap() {
    const now = Date.now()
    const elapsed = now - this.lastLifecycleTick
    this.lastLifecycleTick = now
    if (elapsed <= WAKE_GAP_MS || !this.isDocumentVisible()) return

    // Some standalone WebViews resume timers without dispatching a matching
    // visibility/pageshow event. Treat the clock jump as a wake hint: prove an
    // OPEN socket, or restart a transport that is no longer usable.
    if (this.lifecyclePaused || this.ws?.readyState !== WebSocket.OPEN) {
      this.resumeFromBackground()
      return
    }
    this.beginResumeRecovery()
    this.startPing()
    this.sendVisibility()
    this.sendPingNow(RESUME_PONG_TIMEOUT_MS, true)
  }

  private beginResumeRecovery() {
    if (this.resumeRecoveryTimer) return
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

  private scheduleReconnect(foregroundRecovery = false) {
    if (this.reconnectTimer) return
    // Suspended browser/iOS sessions recover on foreground. The Android wrapper
    // explicitly protects its timers and connection while backgrounded.
    if (!this.isDocumentVisible() && !this.keepsAndroidConnection()) return
    const delay = foregroundRecovery
      ? RESUME_RECONNECT_SETTLE_MS
      : Math.min(INITIAL_RECONNECT_MS * (2 ** this.reconnectAttempts), MAX_RECONNECT_MS)
        + Math.floor(Math.random() * RECONNECT_JITTER_MS)
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  send(data: any): void {
    if (activeTab.signal.aborted) return
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
activeTab.signal.addEventListener('abort', () => wsClient.disconnect(), { once: true })
