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
