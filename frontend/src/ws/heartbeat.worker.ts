type HeartbeatCommand =
  | { type: 'start'; generation: number; url: string; intervalMs: number; timeoutMs: number }
  | { type: 'stop'; generation: number }
  | { type: 'ping-now'; generation: number; timeoutMs: number }

let activeGeneration = 0
let defaultTimeoutMs = 10_000
let heartbeatSocket: WebSocket | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let pongTimer: ReturnType<typeof setTimeout> | null = null

function clearPongTimer(): void {
  if (pongTimer) {
    clearTimeout(pongTimer)
    pongTimer = null
  }
}

function stopTimers(): void {
  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }
  clearPongTimer()
}

function stopSocket(): void {
  stopTimers()
  const socket = heartbeatSocket
  heartbeatSocket = null
  if (socket) {
    try { socket.close() } catch { /* already closed */ }
  }
}

function reportFailure(generation: number): void {
  if (generation !== activeGeneration) return
  stopSocket()
  self.postMessage({ type: 'timeout', generation })
}

function armWatchdog(generation: number, timeoutMs: number): void {
  clearPongTimer()
  pongTimer = setTimeout(() => {
    pongTimer = null
    reportFailure(generation)
  }, timeoutMs)
}

function requestPing(generation: number, timeoutMs: number): void {
  if (generation !== activeGeneration) return
  const socket = heartbeatSocket
  if (!socket || socket.readyState !== WebSocket.OPEN) return

  try {
    socket.send(JSON.stringify({ type: 'ping' }))
    // Keep the primary application socket warm too. This message may be
    // delayed by main-thread work, but it is deliberately not part of the
    // worker's liveness decision.
    self.postMessage({ type: 'ping-primary', generation })
    armWatchdog(generation, timeoutMs)
  } catch {
    reportFailure(generation)
  }
}

function startSocket(command: Extract<HeartbeatCommand, { type: 'start' }>): void {
  stopSocket()
  activeGeneration = command.generation
  defaultTimeoutMs = command.timeoutMs

  const url = new URL(command.url)
  url.searchParams.set('heartbeat', '1')
  const socket = new WebSocket(url)
  heartbeatSocket = socket

  socket.onopen = () => {
    if (heartbeatSocket !== socket || command.generation !== activeGeneration) return
    // Bound authentication/setup too. The backend sends heartbeat_ready only
    // after the cookie session has been accepted.
    armWatchdog(command.generation, command.timeoutMs)
  }

  socket.onmessage = (event) => {
    if (heartbeatSocket !== socket || command.generation !== activeGeneration) return
    try {
      const data = JSON.parse(String(event.data))
      if (data.type === 'heartbeat_ready') {
        clearPongTimer()
        requestPing(command.generation, command.timeoutMs)
        if (pingTimer) clearInterval(pingTimer)
        pingTimer = setInterval(() => {
          requestPing(command.generation, defaultTimeoutMs)
        }, command.intervalMs)
      } else if (data.type === 'pong') {
        clearPongTimer()
        self.postMessage({ type: 'verified', generation: command.generation })
      } else if (data.event === 'AUTH_ERROR') {
        reportFailure(command.generation)
      }
    } catch {
      // Ignore unrelated/malformed frames on the heartbeat-only connection.
    }
  }

  socket.onclose = () => {
    if (heartbeatSocket !== socket || command.generation !== activeGeneration) return
    reportFailure(command.generation)
  }

  socket.onerror = () => {
    if (heartbeatSocket === socket && command.generation === activeGeneration) {
      try { socket.close() } catch { /* onclose/report timeout handles it */ }
    }
  }
}

self.onmessage = (event: MessageEvent<HeartbeatCommand>) => {
  const command = event.data
  switch (command.type) {
    case 'start':
      startSocket(command)
      break
    case 'stop':
      activeGeneration = command.generation
      stopSocket()
      break
    case 'ping-now':
      requestPing(command.generation, command.timeoutMs)
      break
  }
}
