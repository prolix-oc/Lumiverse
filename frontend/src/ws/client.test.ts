/// <reference types="bun-types" />

import { afterAll, describe, expect, jest, test } from 'bun:test'

const originalWindow = (globalThis as any).window
const originalDocument = (globalThis as any).document
const originalWebSocket = (globalThis as any).WebSocket
const originalWorker = (globalThis as any).Worker

function makeEventTarget() {
  const target = new EventTarget()
  return {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  }
}

let documentFocused = true

const documentMock = {
  visibilityState: 'visible' as DocumentVisibilityState,
  hasFocus: () => documentFocused,
  ...makeEventTarget(),
}

const windowMock = {
  location: {
    protocol: 'http:',
    host: 'localhost:3000',
  },
  ...makeEventTarget(),
}

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.CONNECTING
  sent: string[] = []
  closeCalls = 0

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this)
  }

  open() {
    this.readyState = MockWebSocket.OPEN
    ;(this as any).onopen?.({} as Event)
  }

  receive(data: unknown) {
    ;(this as any).onmessage?.({ data: JSON.stringify(data) })
  }

  send(payload: string) {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error('Socket is not open')
    this.sent.push(payload)
  }

  close() {
    this.closeCalls += 1
  }
}

class MockWorker {
  static instances: MockWorker[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  sent: any[] = []

  constructor(_url: URL, _options?: WorkerOptions) {
    MockWorker.instances.push(this)
  }

  postMessage(payload: any) {
    this.sent.push(payload)
  }

  emit(payload: any) {
    this.onmessage?.({ data: payload } as MessageEvent)
  }

  terminate() {}
}

;(globalThis as any).window = windowMock
;(globalThis as any).document = documentMock
;(globalThis as any).WebSocket = MockWebSocket
;(globalThis as any).Worker = MockWorker

const { WebSocketClient, shouldUseHeartbeatWorker } = await import('./client')

afterAll(() => {
  if (originalWindow === undefined) delete (globalThis as any).window
  else (globalThis as any).window = originalWindow

  if (originalDocument === undefined) delete (globalThis as any).document
  else (globalThis as any).document = originalDocument

  if (originalWebSocket === undefined) delete (globalThis as any).WebSocket
  else (globalThis as any).WebSocket = originalWebSocket

  if (originalWorker === undefined) delete (globalThis as any).Worker
  else (globalThis as any).Worker = originalWorker
})

function makeClient() {
  const client = new WebSocketClient('ws://localhost:3000/api/ws') as any
  client.ws = new MockWebSocket('ws://localhost:3000/api/ws')
  client.ws.open()
  return client
}

describe('WebSocketClient push presence', () => {
  test('widget connections stay ineligible for execution ownership after reconnect', () => {
    const client = new WebSocketClient('ws://localhost:3000/api/ws')
    try {
      client.connect({ executionOwner: false })
      expect(new URL(MockWebSocket.instances.at(-1)!.url).searchParams.get('frontend_runtime')).toBe('widget')
      client.disconnect()
      client.connect()
      expect(new URL(MockWebSocket.instances.at(-1)!.url).searchParams.get('frontend_runtime')).toBe('widget')
    } finally { client.disconnect() }
  })

  test('reconnections retain the document identifier and existing URL parameters', async () => {
    const { frontendSessionId } = await import('@/lib/frontend-session')
    const client = new WebSocketClient('ws://localhost:3000/api/ws?ticket=test')
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        client.connect()
        const url = new URL(MockWebSocket.instances.at(-1)!.url)
        expect(url.searchParams.get('frontend_session')).toBe(frontendSessionId)
        expect(url.searchParams.get('ticket')).toBe('test')
        client.disconnect()
      }
    } finally { client.disconnect() }
  })

  test('forwards host revisions and mutation identifiers without changing event payloads', () => {
    const client = new WebSocketClient('ws://localhost:3000/api/ws');
    const seen: unknown[] = [];
    client.on('MESSAGE_EDITED', (payload, metadata) => seen.push({ payload, metadata }));
    try {
      client.connect();
      const socket = MockWebSocket.instances.at(-1)!;
      socket.open();
      const payload = { chatId: 'chat', message: { id: 'message', content: 'edited' } };
      const metadata = { stateRevision: { epoch: 'host', sequence: 2 }, runtimeMutationId: 'mutation' };
      socket.receive({ event: 'MESSAGE_EDITED', payload, ...metadata });
      expect(seen).toEqual([{ payload, metadata }]);
    } finally { client.disconnect(); }
  });

  test.each([1006, 1013])('reconnects after a slow-consumer close (%s) and restores the focused stream before recovery handlers', (code) => {
    jest.useFakeTimers()
    const client = new WebSocketClient('ws://localhost:3000/api/ws')
    try {
      client.setFocusedChat('streaming-chat')
      client.connect()
      const slowSocket = MockWebSocket.instances.at(-1)!
      slowSocket.open()
      slowSocket.readyState = MockWebSocket.CLOSED
      ;(slowSocket as any).onclose({ code, reason: 'backpressure' })
      expect(client.connected).toBe(false)

      jest.advanceTimersByTime(4_000)
      const recovered = MockWebSocket.instances.at(-1)!
      expect(recovered).not.toBe(slowSocket)
      recovered.open()
      recovered.sent = []
      let focusAtRecovery: unknown
      client.on('CONNECTED', () => {
        focusAtRecovery = recovered.sent.map(frame => JSON.parse(frame)).find(frame => frame.type === 'stream_focus')
      })
      recovered.receive({ event: 'CONNECTED', payload: { role: 'user' } })
      expect(client.connected).toBe(true)
      expect(focusAtRecovery).toEqual({ type: 'stream_focus', chatId: 'streaming-chat' })
    } finally {
      client.disconnect()
      jest.useRealTimers()
    }
  })

  test('reports current presence and stream focus after opening and after authentication', () => {
    const client = new WebSocketClient('ws://localhost:3000/api/ws')
    try {
      client.setFocusedChat('chat-1')
      client.connect()
      const socket = MockWebSocket.instances.at(-1)!
      expect(socket.sent).toEqual([])

      socket.open()
      expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual([
        { type: 'visibility', visible: true },
        { type: 'stream_focus', chatId: 'chat-1' },
      ])

      // The server authenticates asynchronously after the transport opens.
      // Replay presence before application CONNECTED handlers can send work.
      socket.sent = []
      let framesAtConnected: unknown[] = []
      client.on('CONNECTED', () => { framesAtConnected = socket.sent.map((frame) => JSON.parse(frame)) })
      socket.receive({ event: 'CONNECTED', payload: { role: 'user' } })
      expect(framesAtConnected).toEqual([
        { type: 'visibility', visible: true },
        { type: 'stream_focus', chatId: 'chat-1' },
      ])
    } finally {
      client.disconnect()
    }
  })

  test('reports hidden if the app backgrounds during connection or authentication', () => {
    const client = new WebSocketClient('ws://localhost:3000/api/ws')
    try {
      client.connect()
      const socket = MockWebSocket.instances.at(-1)!
      documentMock.visibilityState = 'hidden'
      documentMock.dispatchEvent(new Event('visibilitychange'))
      socket.open()
      socket.receive({ event: 'CONNECTED', payload: { role: 'user' } })
      expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual([
        { type: 'visibility', visible: false },
        { type: 'stream_focus', chatId: null },
        { type: 'visibility', visible: false },
        { type: 'stream_focus', chatId: null },
      ])
    } finally {
      client.disconnect()
      documentMock.visibilityState = 'visible'
    }
  })

  test('reports a visible but non-frontmost browser window as inactive', () => {
    const client = new WebSocketClient('ws://localhost:3000/api/ws') as any
    try {
      client.connect()
      const socket = MockWebSocket.instances.at(-1)!
      socket.open()
      socket.sent = []

      documentFocused = false
      windowMock.dispatchEvent(new Event('blur'))
      expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({
        type: 'visibility',
        visible: false,
      })

      documentFocused = true
      windowMock.dispatchEvent(new Event('focus'))
      expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({
        type: 'visibility',
        visible: true,
      })
    } finally {
      client.disconnect()
      documentFocused = true
    }
  })

  test('reduces native hidden, minimized, and background states to inactive presence', () => {
    const client = makeClient()
    try {
      const socket = client.ws as MockWebSocket
      socket.sent = []
      const states = [
        { state: 'hidden', visible: false, minimized: false, focused: false },
        { state: 'minimized', visible: true, minimized: true, focused: false },
        { state: 'background', visible: true, minimized: false, focused: false },
      ] as const

      for (const presence of states) {
        client.desktopPresence = { ...presence, active: false }
        client.sendVisibility()
      }

      expect(socket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === 'visibility'))
        .toEqual(states.map((presence) => ({
          type: 'visibility',
          visible: false,
          source: 'tauri',
          state: presence.state,
          windowVisible: presence.visible,
          minimized: presence.minimized,
          focused: presence.focused,
        })))
    } finally {
      client.disconnect()
    }
  })

  test('trusts active native presence when WebView2 page visibility is stale', () => {
    const client = makeClient()
    try {
      const socket = client.ws as MockWebSocket
      socket.sent = []
      client.focusedChatId = 'chat-1'
      client.lifecyclePaused = true
      documentMock.visibilityState = 'hidden'

      client.applyDesktopPresence({
        state: 'foreground',
        visible: true,
        minimized: false,
        focused: true,
        active: true,
      })

      expect(client.lifecyclePaused).toBe(false)
      expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({
        type: 'visibility',
        visible: true,
        source: 'tauri',
        state: 'foreground',
        windowVisible: true,
        minimized: false,
        focused: true,
      })
      expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({
        type: 'stream_focus',
        chatId: 'chat-1',
      })
    } finally {
      client.disconnect()
      documentMock.visibilityState = 'visible'
    }
  })

  test('trusts hidden native presence when WebView2 still reports visible', () => {
    const client = makeClient()
    try {
      const socket = client.ws as MockWebSocket
      socket.sent = []
      client.focusedChatId = 'chat-1'

      client.applyDesktopPresence({
        state: 'hidden',
        visible: false,
        minimized: false,
        focused: false,
        active: false,
      })

      expect(client.lifecyclePaused).toBe(true)
      expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({
        type: 'visibility',
        visible: false,
        source: 'tauri',
        state: 'hidden',
        windowVisible: false,
        minimized: false,
        focused: false,
      })
      expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({
        type: 'stream_focus',
        chatId: null,
      })
    } finally {
      client.disconnect()
    }
  })

  test('restores foreground presence after repeated PWA suspension and reconnection', () => {
    jest.useFakeTimers()
    const client = new WebSocketClient('ws://localhost:3000/api/ws')
    try {
      client.connect()
      MockWebSocket.instances.at(-1)!.open()
      for (let cycle = 0; cycle < 3; cycle++) {
        documentMock.visibilityState = 'hidden'
        windowMock.dispatchEvent(new Event('pagehide'))
        documentMock.visibilityState = 'visible'
        windowMock.dispatchEvent(new Event('pageshow'))
        jest.advanceTimersByTime(250)
        const socket = MockWebSocket.instances.at(-1)!
        expect(socket.readyState).toBe(MockWebSocket.CONNECTING)
        expect(socket.sent).toEqual([])
        socket.open()
        socket.receive({ event: 'CONNECTED', payload: { role: 'user' } })
        expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({ type: 'visibility', visible: true })
      }
    } finally {
      client.disconnect()
      documentMock.visibilityState = 'visible'
      jest.useRealTimers()
    }
  })

  test('repairs hidden presence when a PWA resumes without a visibility event', () => {
    jest.useFakeTimers()
    const client = new WebSocketClient('ws://localhost:3000/api/ws') as any
    try {
      client.connect()
      const socket = MockWebSocket.instances.at(-1)!
      socket.open()
      documentMock.visibilityState = 'hidden'
      documentMock.dispatchEvent(new Event('visibilitychange'))
      socket.sent = []
      documentMock.visibilityState = 'visible'
      client.lastLifecycleTick = Date.now() - 20_000
      client.checkForWakeGap()
      expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({ type: 'visibility', visible: true })
      expect(client.lifecyclePaused).toBe(false)
    } finally {
      client.disconnect()
      documentMock.visibilityState = 'visible'
      jest.useRealTimers()
    }
  })
})

describe('WebSocketClient Android native lifecycle', () => {
  test('a protected background connection retains tokens, heartbeat and reconnects while presence stays hidden', () => {
    jest.useFakeTimers()
    const client = new WebSocketClient('ws://localhost:3000/api/ws')
    try {
      Object.assign(windowMock, { __LUMIVERSE_ANDROID_ACTIVE__: true, __LUMIVERSE_ANDROID_BACKGROUND_CONNECTION__: true })
      client.setFocusedChat('background-tts')
      client.connect()
      const socket = MockWebSocket.instances.at(-1)!
      socket.open(); socket.sent = []
      const worker = MockWorker.instances.at(-1)!
      worker.sent = []
      Object.assign(windowMock, { __LUMIVERSE_ANDROID_ACTIVE__: false })
      documentMock.visibilityState = 'hidden'; documentFocused = false
      windowMock.dispatchEvent(Object.assign(new Event('lumiverse:android-app-state'), { detail: { state: 'background' } }))
      const frames = socket.sent.map(frame => JSON.parse(frame))
      expect(frames).toContainEqual({ type: 'visibility', visible: false })
      expect(frames).toContainEqual({ type: 'stream_focus', chatId: 'background-tts' })
      expect(worker.sent.at(-1)?.type).toBe('start')
      const generation = worker.sent.at(-1).generation
      worker.emit({ type: 'ping', generation, timeoutMs: 10_000 })
      expect(socket.sent.map(frame => JSON.parse(frame)).at(-1)?.type).toBe('ping')
      const before = MockWebSocket.instances.length
      socket.readyState = MockWebSocket.CLOSED
      ;(socket as any).onclose({ code: 1006, reason: 'network changed' })
      jest.advanceTimersByTime(5000)
      expect(MockWebSocket.instances.length).toBe(before + 1)
      const reconnected = MockWebSocket.instances.at(-1)!
      reconnected.open()
      const restarted = worker.sent.at(-1)
      expect(restarted.type).toBe('start')
      worker.emit({ type: 'ping', generation: restarted.generation, timeoutMs: 10_000 })
      expect(reconnected.sent.map(frame => JSON.parse(frame))).toContainEqual({ type: 'stream_focus', chatId: 'background-tts' })
      expect(reconnected.sent.map(frame => JSON.parse(frame)).at(-1)?.type).toBe('ping')
    } finally {
      client.disconnect()
      Reflect.deleteProperty(windowMock, '__LUMIVERSE_ANDROID_ACTIVE__')
      Reflect.deleteProperty(windowMock, '__LUMIVERSE_ANDROID_BACKGROUND_CONNECTION__')
      documentMock.visibilityState = 'visible'; documentFocused = true
      jest.useRealTimers()
    }
  })

  test('native background releases presence and resume restores chat focus when WebView visibility is stale', () => {
    const client = new WebSocketClient('ws://localhost:3000/api/ws')
    const state = (active: boolean) => {
      Object.assign(windowMock, { __LUMIVERSE_ANDROID_ACTIVE__: active })
      windowMock.dispatchEvent(Object.assign(new Event('lumiverse:android-app-state'), { detail: { state: active ? 'active' : 'background' } }))
    }
    try {
      Object.assign(windowMock, { __LUMIVERSE_ANDROID_ACTIVE__: true })
      client.setFocusedChat('android-chat')
      client.connect()
      const socket = MockWebSocket.instances.at(-1)!
      socket.open(); socket.sent = []
      state(false)
      expect(socket.sent.map(frame => JSON.parse(frame))).toContainEqual({ type: 'visibility', visible: false })
      documentMock.visibilityState = 'hidden'; documentFocused = false; socket.sent = []
      state(true)
      const frames = socket.sent.map(frame => JSON.parse(frame))
      expect(frames).toContainEqual({ type: 'visibility', visible: true })
      expect(frames).toContainEqual({ type: 'stream_focus', chatId: 'android-chat' })
    } finally {
      client.disconnect(); Reflect.deleteProperty(windowMock, '__LUMIVERSE_ANDROID_ACTIVE__')
      documentMock.visibilityState = 'visible'; documentFocused = true
    }
  })
})

describe('WebSocketClient iOS native lifecycle', () => {
  const emitState = (state: string) => windowMock.dispatchEvent(
    Object.assign(new Event('lumiverse:ios-app-state'), { detail: { state } }),
  )
  const installBridge = () => {
    Object.assign(windowMock, {
      __LUMIVERSE_MOBILE__: true, __LUMIVERSE_PLATFORM__: 'ios',
      __LUMIVERSE_IOS_NATIVE__: { version: 1, request: async () => ({ state: 'active' }) },
    })
    ;(globalThis as any).Worker = undefined
  }
  const resetBridge = () => {
    for (const key of ['__LUMIVERSE_MOBILE__', '__LUMIVERSE_PLATFORM__', '__LUMIVERSE_IOS_NATIVE__']) {
      Reflect.deleteProperty(windowMock, key)
    }
    documentMock.visibilityState = 'visible'
    documentFocused = true
    ;(globalThis as any).Worker = MockWorker
  }

  test('restores stream focus after a brief app switch with stale WebKit visibility and focus', async () => {
    installBridge()
    const client = new WebSocketClient('ws://localhost:3000/api/ws')
    try {
      client.setFocusedChat('chat-1')
      client.connect()
      const socket = MockWebSocket.instances.at(-1)!
      socket.open()
      await Promise.resolve()
      await Promise.resolve()
      socket.sent = []

      // No browser visibilitychange/focus event or timer gap accompanies this
      // switch. UIKit alone tells us that the app left and came back.
      emitState('inactive')
      emitState('background')
      expect(socket.sent.map(frame => JSON.parse(frame))).toContainEqual({ type: 'visibility', visible: false })
      expect(socket.sent.map(frame => JSON.parse(frame))).toContainEqual({ type: 'stream_focus', chatId: null })

      documentMock.visibilityState = 'hidden'
      documentFocused = false
      socket.sent = []
      emitState('active')
      const frames = socket.sent.map(frame => JSON.parse(frame))
      expect(frames).toContainEqual({ type: 'visibility', visible: true })
      expect(frames).toContainEqual({ type: 'stream_focus', chatId: 'chat-1' })
      const probe = frames.find(frame => frame.type === 'ping')
      expect(probe?.id).toBeString()
      let recovered = 0
      client.on('__ws_resume_recovery_complete', () => { recovered++ })
      socket.receive({ type: 'pong', id: probe.id })
      expect(recovered).toBe(1)
    } finally { client.disconnect(); resetBridge() }
  })

  test('probes on activation even when JS missed the native background event', async () => {
    installBridge()
    const client = new WebSocketClient('ws://localhost:3000/api/ws')
    try {
      client.connect()
      const socket = MockWebSocket.instances.at(-1)!
      socket.open()
      await Promise.resolve()
      await Promise.resolve()
      socket.sent = []
      emitState('active')
      expect(socket.sent.map(frame => JSON.parse(frame)).find(frame => frame.type === 'ping')?.id).toBeString()
    } finally { client.disconnect(); resetBridge() }
  })

  test('reconnects a closed transport on native activation while WebKit still reports hidden', async () => {
    jest.useFakeTimers()
    installBridge()
    const client = new WebSocketClient('ws://localhost:3000/api/ws')
    try {
      client.setFocusedChat('chat-1')
      client.connect()
      const oldSocket = MockWebSocket.instances.at(-1)!
      oldSocket.open()
      await Promise.resolve()
      await Promise.resolve()
      emitState('background')
      oldSocket.readyState = MockWebSocket.CLOSED
      documentMock.visibilityState = 'hidden'
      documentFocused = false
      emitState('active')
      jest.advanceTimersByTime(250)
      const newSocket = MockWebSocket.instances.at(-1)!
      expect(newSocket).not.toBe(oldSocket)
      newSocket.open()
      newSocket.receive({ event: 'CONNECTED', payload: {} })
      expect(newSocket.sent.map(frame => JSON.parse(frame))).toContainEqual({ type: 'stream_focus', chatId: 'chat-1' })
    } finally { client.disconnect(); resetBridge(); jest.useRealTimers() }
  })
})

describe('WebSocketClient resume watchdog guard', () => {
  test('does not use a heartbeat worker on iOS or iPadOS', () => {
    expect(shouldUseHeartbeatWorker({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)',
      platform: 'iPhone',
      maxTouchPoints: 5,
    })).toBe(false)
    expect(shouldUseHeartbeatWorker({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    })).toBe(false)
  })

  test('keeps the heartbeat worker available on Android', () => {
    expect(shouldUseHeartbeatWorker({
      userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 Chrome/140 Mobile',
      platform: 'Linux armv8l',
      maxTouchPoints: 5,
    })).toBe(true)
  })

  test('sends the fast watchdog ping on an unsuppressed hidden-to-visible transition', () => {
    const client = makeClient()
    const pingTimeouts: number[] = []

    client.sendPingNow = (timeoutMs: number) => {
      pingTimeouts.push(timeoutMs)
    }
    client.wasVisible = false

    client.sendVisibility()

    expect(pingTimeouts).toEqual([15_000])
  })

  test('suppresses the next fast watchdog ping once when a system modal is expected', () => {
    const client = makeClient()
    const pingTimeouts: number[] = []

    client.sendPingNow = (timeoutMs: number) => {
      pingTimeouts.push(timeoutMs)
    }
    client.wasVisible = false
    client.suppressNextResumePingFor(120_000)

    client.sendVisibility()
    expect(pingTimeouts).toEqual([])

    client.wasVisible = false
    client.sendVisibility()
    expect(pingTimeouts).toEqual([15_000])
  })

  test('uses the worker to schedule and watch the primary socket heartbeat', () => {
    const client = makeClient()
    const socket = client.ws as MockWebSocket
    client.startPing()

    const worker = MockWorker.instances.at(-1)!
    const start = worker.sent.find((message) => message.type === 'start')
    expect(start).toMatchObject({ intervalMs: 30_000, timeoutMs: 15_000 })

    worker.emit({ type: 'ping', generation: start.generation, timeoutMs: 15_000 })
    expect(socket.sent).toEqual([JSON.stringify({ type: 'ping' })])
    expect(worker.sent.at(-1)).toEqual({
      type: 'arm',
      generation: start.generation,
      timeoutMs: 15_000,
    })

    worker.emit({ type: 'timeout', generation: start.generation })
    expect(socket.closeCalls).toBe(1)
    expect(client.ws).toBeNull()
    client.disconnect()
  })

  test('acknowledges primary pongs and ignores stale worker timeouts', () => {
    const client = makeClient()
    const socket = client.ws as MockWebSocket
    client.startPing()
    const worker = MockWorker.instances.at(-1)!
    const firstStart = worker.sent.find((message) => message.type === 'start')
    client.ackHeartbeat()
    expect(worker.sent.at(-1)).toEqual({ type: 'ack', generation: firstStart.generation })

    client.startPing()
    worker.emit({ type: 'timeout', generation: firstStart.generation })
    expect(socket.closeCalls).toBe(0)
    expect(client.ws).toBe(socket)
    client.disconnect()
  })

  test('invalidates a heartbeat deadline while the PWA is backgrounded', () => {
    const client = makeClient()
    const socket = client.ws as MockWebSocket
    client.startPing()
    const worker = MockWorker.instances.at(-1)!
    const start = worker.sent.find((message) => message.type === 'start')

    client.pauseForBackground()
    worker.emit({ type: 'timeout', generation: start.generation })

    expect(socket.closeCalls).toBe(0)
    expect(client.ws).toBe(socket)
    client.disconnect()
  })

  test('requires an ID-correlated pong to complete foreground recovery', () => {
    const client = new WebSocketClient('ws://localhost:3000/api/ws') as any
    client.connect()
    const socket = MockWebSocket.instances.at(-1)!
    socket.open()
    const events: string[] = []
    client.on('__ws_resume_recovery_start', () => events.push('start'))
    client.on('__ws_resume_recovery_complete', () => events.push('complete'))

    client.pauseForBackground()
    client.resumeFromBackground()
    const worker = MockWorker.instances.at(-1)!
    const resumePing = worker.sent.find((message) => message.type === 'ping-now' && message.resumeProof)
    expect(resumePing).toMatchObject({ timeoutMs: 15_000, resumeProof: true })

    worker.emit({ type: 'ping', generation: resumePing.generation, timeoutMs: 15_000, resumeProof: true })
    const frame = JSON.parse(socket.sent.at(-1)!)
    expect(frame).toMatchObject({ type: 'ping' })
    expect(typeof frame.id).toBe('string')

    ;(socket as any).onmessage({ data: JSON.stringify({ type: 'pong', id: frame.id }) })
    expect(events).toEqual(['start', 'complete'])
    client.disconnect()
  })

  test('abandons a socket that remains CONNECTING beyond the handshake deadline', () => {
    jest.useFakeTimers()
    const client = new WebSocketClient('ws://localhost:3000/api/ws') as any
    const closes: any[] = []
    client.on('__ws_close', (payload: any) => closes.push(payload))

    try {
      client.connect()
      const socket = MockWebSocket.instances.at(-1)!
      socket.readyState = MockWebSocket.CONNECTING

      jest.advanceTimersByTime(14_999)
      expect(socket.closeCalls).toBe(0)

      jest.advanceTimersByTime(1)
      expect(socket.closeCalls).toBe(1)
      expect(client.ws).toBeNull()
      expect(closes).toEqual([{ code: 1006, reason: 'connection timeout' }])
    } finally {
      client.disconnect()
      jest.useRealTimers()
    }
  })

  test('releases the transport on freeze and starts a fresh foreground recovery', () => {
    jest.useFakeTimers()
    const client = makeClient()
    const socket = client.ws as MockWebSocket
    const events: string[] = []
    client.on('__ws_resume_recovery_start', () => events.push('start'))

    try {
      client.pauseForBackground()
      client.suspendTransport('page frozen')

      expect(socket.closeCalls).toBe(1)
      expect(client.ws).toBeNull()

      client.resumeFromBackground()
      expect(events).toEqual(['start'])
      jest.advanceTimersByTime(249)
      expect(client.ws).toBeNull()
      jest.advanceTimersByTime(1)
      expect(client.ws).toBe(MockWebSocket.instances.at(-1))
    } finally {
      client.disconnect()
      jest.useRealTimers()
    }
  })

  test('starts recovery when foregrounding finds no socket even if a hidden event was missed', () => {
    jest.useFakeTimers()
    const client = makeClient()
    const socket = client.ws as MockWebSocket
    const events: string[] = []
    client.on('__ws_resume_recovery_start', () => events.push('start'))

    try {
      client.abandonSocket(socket)
      client.recoverConnectionOnForeground('focus')
      expect(events).toEqual(['start'])
      jest.advanceTimersByTime(250)
      expect(client.ws).toBe(MockWebSocket.instances.at(-1))
    } finally {
      client.disconnect()
      jest.useRealTimers()
    }
  })

  test('uses a timer gap to probe an OPEN socket when lifecycle events were missed', () => {
    jest.useFakeTimers()
    const client = makeClient()
    const events: string[] = []
    client.on('__ws_resume_recovery_start', () => events.push('start'))

    try {
      client.lastLifecycleTick = Date.now() - 20_000
      client.checkForWakeGap()

      expect(events).toEqual(['start'])
      const worker = MockWorker.instances.at(-1)!
      expect(worker.sent.some((message) => (
        message.type === 'ping-now'
        && message.timeoutMs === 15_000
        && message.resumeProof === true
      ))).toBe(true)
    } finally {
      client.disconnect()
      jest.useRealTimers()
    }
  })
})

describe('WebSocketClient Spindle console logging', () => {
  test('suppresses routine incoming WebSocket traces without suppressing event dispatch', () => {
    const client = new WebSocketClient('ws://localhost:3000/api/ws')
    const originalDebug = console.debug
    const logged: unknown[][] = []
    const received: string[] = []
    console.debug = (...args: unknown[]) => { logged.push(args) }

    try {
      client.on('SPINDLE_RUNTIME_STATS', () => received.push('spindle'))
      client.on('MESSAGE_SENT', () => received.push('message'))
      client.setSpindleInfoLogging(false)
      client.connect()
      const socket = MockWebSocket.instances.at(-1)!

      ;(socket as any).onmessage({ data: JSON.stringify({ event: 'SPINDLE_RUNTIME_STATS', payload: {} }) })
      ;(socket as any).onmessage({ data: JSON.stringify({ event: 'MESSAGE_SENT', payload: {} }) })

      expect(logged).toEqual([])
      expect(received).toEqual(['spindle', 'message'])

      client.setSpindleInfoLogging(true)
      ;(socket as any).onmessage({ data: JSON.stringify({ event: 'MESSAGE_SENT', payload: {} }) })

      expect(logged).toEqual([['[WS] ←', 'MESSAGE_SENT', {}]])
      expect(received).toEqual(['spindle', 'message', 'message'])
    } finally {
      console.debug = originalDebug
      client.disconnect()
    }
  })
})

test('takeover closes the primary socket and cannot reconnect on foreground recovery', async () => {
  const { activeTab } = await import('@/lib/active-tab')
  const { wsClient } = await import('./client')
  Object.assign(windowMock, { localStorage, document: documentMock })
  const release = activeTab.claim('socket-account')
  try {
    wsClient.connect()
    const socket = MockWebSocket.instances.at(-1)!
    socket.open()
    localStorage.setItem('lumiverse:active-tab:socket-account', 'replacement')
    windowMock.dispatchEvent(new Event('focus'))
    expect(activeTab.signal.aborted).toBe(true)
    expect(socket.closeCalls).toBe(1)
    const count = MockWebSocket.instances.length
    wsClient.connect()
    documentMock.dispatchEvent(new Event('visibilitychange'))
    expect(MockWebSocket.instances).toHaveLength(count)
    const sent = socket.sent.length
    wsClient.send({ type: 'stale-write' })
    expect(socket.sent).toHaveLength(sent)
  } finally { release(); wsClient.disconnect() }
})
