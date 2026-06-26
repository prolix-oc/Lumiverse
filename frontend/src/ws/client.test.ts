/// <reference types="bun-types" />

import { afterAll, describe, expect, test } from 'bun:test'

const originalWindow = (globalThis as any).window
const originalDocument = (globalThis as any).document
const originalWebSocket = (globalThis as any).WebSocket

type Listener = EventListenerOrEventListenerObject

function makeEventTarget() {
  return {
    addEventListener(_type: string, _listener: Listener) {},
    removeEventListener(_type: string, _listener: Listener) {},
  }
}

const documentMock = {
  visibilityState: 'visible' as DocumentVisibilityState,
  hasFocus: () => true,
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

  readyState = MockWebSocket.OPEN
  sent: string[] = []

  constructor(_url: string) {}

  send(payload: string) {
    this.sent.push(payload)
  }

  close() {}
}

;(globalThis as any).window = windowMock
;(globalThis as any).document = documentMock
;(globalThis as any).WebSocket = MockWebSocket

const { WebSocketClient } = await import('./client')

afterAll(() => {
  if (originalWindow === undefined) delete (globalThis as any).window
  else (globalThis as any).window = originalWindow

  if (originalDocument === undefined) delete (globalThis as any).document
  else (globalThis as any).document = originalDocument

  if (originalWebSocket === undefined) delete (globalThis as any).WebSocket
  else (globalThis as any).WebSocket = originalWebSocket
})

function makeClient() {
  const client = new WebSocketClient('ws://localhost:3000/api/ws') as any
  client.ws = new MockWebSocket('ws://localhost:3000/api/ws')
  return client
}

describe('WebSocketClient resume watchdog guard', () => {
  test('sends the fast watchdog ping on an unsuppressed hidden-to-visible transition', () => {
    const client = makeClient()
    const pingTimeouts: number[] = []

    client.sendPingNow = (timeoutMs: number) => {
      pingTimeouts.push(timeoutMs)
    }
    client.wasVisible = false

    client.sendVisibility()

    expect(pingTimeouts).toEqual([3_000])
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
    expect(pingTimeouts).toEqual([3_000])
  })
})
