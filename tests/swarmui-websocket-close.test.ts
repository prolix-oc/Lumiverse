import { describe, expect, test } from "bun:test"
import { closeWebSocketGracefully } from "../src/image-gen/providers/ws-helpers"

class FakeWebSocket extends EventTarget {
  readyState = WebSocket.OPEN
  readonly closeCalls: Array<{ code?: number; reason?: string }> = []

  constructor(private readonly closeDelayMs = 0) {
    super()
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason })
    this.readyState = WebSocket.CLOSING
    setTimeout(() => this.finishClose(), this.closeDelayMs)
  }

  beginRemoteClose(delayMs = 0): void {
    this.readyState = WebSocket.CLOSING
    setTimeout(() => this.finishClose(), delayMs)
  }

  finishClose(): void {
    if (this.readyState === WebSocket.CLOSED) return
    this.readyState = WebSocket.CLOSED
    this.dispatchEvent(new Event("close"))
  }
}

function asWebSocket(socket: FakeWebSocket): WebSocket {
  return socket as unknown as WebSocket
}

describe("closeWebSocketGracefully", () => {
  test("returns immediately when already closed", async () => {
    const socket = new FakeWebSocket()
    socket.finishClose()

    await closeWebSocketGracefully(asWebSocket(socket), 50)

    expect(socket.readyState).toBe(WebSocket.CLOSED)
    expect(socket.closeCalls).toEqual([])
  })

  test("awaits a close already initiated by the peer", async () => {
    const socket = new FakeWebSocket()
    socket.beginRemoteClose(10)

    await closeWebSocketGracefully(asWebSocket(socket), 50)

    expect(socket.readyState).toBe(WebSocket.CLOSED)
    expect(socket.closeCalls).toEqual([])
  })

  test("initiates a normal client close and awaits the handshake", async () => {
    const socket = new FakeWebSocket(20)
    let resolved = false

    const closing = closeWebSocketGracefully(asWebSocket(socket), 100).then(() => {
      resolved = true
    })

    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "complete" }])
    expect(socket.readyState).toBe(WebSocket.CLOSING)
    expect(resolved).toBe(false)

    await closing
    expect(socket.readyState).toBe(WebSocket.CLOSED)
    expect(resolved).toBe(true)
  })

  test("does not hang forever if the peer never acknowledges close", async () => {
    class NeverClosingWebSocket extends FakeWebSocket {
      override close(code?: number, reason?: string): void {
        this.closeCalls.push({ code, reason })
        this.readyState = WebSocket.CLOSING
      }
    }

    const socket = new NeverClosingWebSocket()
    const started = performance.now()

    await closeWebSocketGracefully(asWebSocket(socket), 20)

    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "complete" }])
    expect(socket.readyState).toBe(WebSocket.CLOSING)
    expect(performance.now() - started).toBeGreaterThanOrEqual(15)
  })

  test("supports a short timeout for explicit interruption", async () => {
    const socket = new FakeWebSocket(500)
    const started = performance.now()

    await closeWebSocketGracefully(asWebSocket(socket), 20)

    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "complete" }])
    expect(performance.now() - started).toBeLessThan(200)
  })
})
