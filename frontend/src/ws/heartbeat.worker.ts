type HeartbeatCommand =
  | { type: 'start'; generation: number; intervalMs: number; timeoutMs: number }
  | { type: 'stop'; generation: number }
  | { type: 'ping-now'; generation: number; timeoutMs: number }
  | { type: 'arm'; generation: number; timeoutMs: number }
  | { type: 'ack'; generation: number }

let activeGeneration = 0
let defaultTimeoutMs = 10_000
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

function stop(): void {
  stopTimers()
}

function reportFailure(generation: number): void {
  if (generation !== activeGeneration) return
  stop()
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
  // The client sends this on the real event socket, then replies with `arm`.
  // Waiting to arm until after send avoids false timeouts when the page's main
  // thread is temporarily busy and worker messages are queued.
  self.postMessage({ type: 'ping', generation, timeoutMs })
}

function start(command: Extract<HeartbeatCommand, { type: 'start' }>): void {
  stop()
  activeGeneration = command.generation
  defaultTimeoutMs = command.timeoutMs
  pingTimer = setInterval(() => {
    requestPing(command.generation, defaultTimeoutMs)
  }, command.intervalMs)
}

self.onmessage = (event: MessageEvent<HeartbeatCommand>) => {
  const command = event.data
  switch (command.type) {
    case 'start':
      start(command)
      break
    case 'stop':
      activeGeneration = command.generation
      stop()
      break
    case 'ping-now':
      requestPing(command.generation, command.timeoutMs)
      break
    case 'arm':
      if (command.generation === activeGeneration) {
        armWatchdog(command.generation, command.timeoutMs)
      }
      break
    case 'ack':
      if (command.generation === activeGeneration) clearPongTimer()
      break
  }
}
