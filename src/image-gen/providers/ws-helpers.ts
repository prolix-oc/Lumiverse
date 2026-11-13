// Without this, WS error events stringify as "[object ErrorEvent]".
export function formatWsError(e: unknown): string {
  const anyE = e as { message?: unknown; error?: any; code?: unknown; reason?: unknown; type?: unknown }
  if (typeof anyE?.message === "string" && anyE.message) return anyE.message
  if (anyE?.error) {
    if (typeof anyE.error === "string") return anyE.error
    if (typeof anyE.error.message === "string" && anyE.error.message) return anyE.error.message
    if (typeof anyE.error.code === "string" && anyE.error.code) return anyE.error.code
  }
  if (typeof anyE?.reason === "string" && anyE.reason) return anyE.reason
  if (typeof anyE?.code === "string" && anyE.code) return anyE.code
  if (typeof anyE?.code === "number") return `close code ${anyE.code}`
  if (typeof anyE?.type === "string" && anyE.type && anyE.type !== "error") return anyE.type
  return "connection failed (likely refused / DNS / non-WS endpoint)"
}

type BunPausableWebSocket = WebSocket & {
  pause(): boolean
  resume(): boolean
}

export interface WebSocketReceiveBackpressure {
  enqueued(queueLength: number): void
  dequeued(queueLength: number): void
  release(): void
}

/**
 * Bound an async consumer's decoded-message queue with Bun's WebSocket receive
 * backpressure. Bun may deliver messages decoded just before pause(), so this
 * is a high/low-water controller rather than a hard queue-size limit.
 */
export function createWebSocketReceiveBackpressure(
  ws: WebSocket,
  options: { highWaterMark?: number; lowWaterMark?: number } = {},
): WebSocketReceiveBackpressure {
  const highWaterMark = options.highWaterMark ?? 16
  const lowWaterMark = options.lowWaterMark ?? 4
  if (lowWaterMark < 0 || highWaterMark <= lowWaterMark) {
    throw new RangeError("WebSocket backpressure requires 0 <= lowWaterMark < highWaterMark")
  }

  const socket = ws as BunPausableWebSocket
  let pausedByController = false

  const resume = () => {
    if (!pausedByController) return
    try {
      socket.resume()
    } finally {
      pausedByController = false
    }
  }

  return {
    enqueued(queueLength) {
      if (pausedByController || queueLength < highWaterMark) return
      pausedByController = socket.pause()
    },
    dequeued(queueLength) {
      if (queueLength <= lowWaterMark) resume()
    },
    release: resume,
  }
}

// Opens a WS with a timeout; cleans up listeners on settle so we don't keep
// the event loop alive or leak handlers after resolution. `headers` uses
// Bun's WebSocket constructor extension (WHATWG WebSocket can't set headers).
export async function openWebSocket(
  url: string,
  opts: { label: string; timeoutMs?: number; headers?: Record<string, string> },
): Promise<WebSocket> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const ws = opts.headers
    ? new WebSocket(url, { headers: opts.headers } as any)
    : new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      ws.removeEventListener("open", onOpen)
      ws.removeEventListener("error", onError)
    }
    const onOpen = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const onError = (e: Event) => {
      if (settled) return
      settled = true
      cleanup()
      try { ws.close() } catch {}
      reject(new Error(`${opts.label} WebSocket error: ${formatWsError(e)} (url=${url})`))
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      try { ws.close() } catch {}
      reject(new Error(`${opts.label} WebSocket connection timeout after ${timeoutMs}ms (url=${url})`))
    }, timeoutMs)
    ws.addEventListener("open", onOpen)
    ws.addEventListener("error", onError)
  })
  return ws
}

async function waitForWebSocketClose(ws: WebSocket, timeoutMs: number): Promise<boolean> {
  if (ws.readyState === WebSocket.CLOSED) return true
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (closed: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.removeEventListener("close", onClose)
      resolve(closed)
    }
    const onClose = () => finish(true)
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs))
    ws.addEventListener("close", onClose, { once: true })
  })
}

/**
 * Initiate a normal WebSocket close handshake and briefly await the peer's
 * acknowledgement. Awaiting the close event gives Bun time to flush the close
 * frame instead of letting the request tear down the transport immediately
 * after `ws.close()`.
 *
 * If the peer has already started closing, just wait for that handshake to
 * finish rather than issuing a second close.
 */
export async function closeWebSocketGracefully(
  ws: WebSocket,
  closeTimeoutMs = 1_000,
): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return

  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.close(1000, "complete")
    } catch {
      return
    }
  }

  await waitForWebSocketClose(ws, closeTimeoutMs)
}
