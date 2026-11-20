# Backend Process Watchdog

A backend-only example that spawns a supervised backend subprocess, heartbeats it, relays process-scoped messages, and shuts it down cleanly.

## `spindle.json`

```json
{
  "version": "1.0.0",
  "name": "Backend Watchdog Demo",
  "identifier": "backend_watchdog_demo",
  "author": "Dev",
  "github": "https://github.com/dev/backend-watchdog-demo",
  "homepage": "https://github.com/dev/backend-watchdog-demo",
  "permissions": [],
  "entry_backend": "dist/backend.js"
}
```

## `src/backend.ts`

```ts
declare const spindle: import('lumiverse-spindle-types').SpindleAPI

const activeByUser = new Map<string, string>()

spindle.onFrontendMessage(async (payload: any, userId) => {
  switch (payload?.type) {
    case 'start_loop': {
      const intervalMs = Math.max(1000, Math.min(30_000, Number(payload.intervalMs) || 5000))

      const process = await spindle.backendProcesses.spawn({
        entry: 'dist/backend-processes/watchdog.js',
        kind: 'watchdog-loop',
        key: 'main',
        userId,
        payload: { intervalMs },
        startupTimeoutMs: 10_000,
        heartbeatTimeoutMs: intervalMs * 2 + 2000,
        replaceExisting: true,
      })

      activeByUser.set(userId, process.processId)

      spindle.sendToFrontend({
        type: 'watchdog_status',
        processId: process.processId,
        state: 'starting',
        intervalMs,
      }, userId)
      break
    }

    case 'stop_loop': {
      const processId = activeByUser.get(userId)
      if (!processId) return

      await spindle.backendProcesses.stop(processId, {
        userId,
        reason: 'user_requested',
      })
      break
    }
  }
})

spindle.backendProcesses.onMessage((event) => {
  if ((event.payload as any)?.type !== 'tick') return

  spindle.sendToFrontend({
    type: 'watchdog_tick',
    processId: event.processId,
    at: (event.payload as any).at,
    count: (event.payload as any).count,
  }, event.userId)
})

spindle.backendProcesses.onLifecycle((event) => {
  if (event.userId) {
    if (activeByUser.get(event.userId) === event.processId) {
      if (['stopped', 'completed', 'failed', 'timed_out'].includes(event.state)) {
        activeByUser.delete(event.userId)
      }
    }

    spindle.sendToFrontend({
      type: 'watchdog_status',
      processId: event.processId,
      state: event.state,
      error: event.error,
      exitReason: event.exitReason,
    }, event.userId)
  }
})

spindle.log.info('Backend watchdog demo loaded')
```

## `src/backend-processes/watchdog.ts`

```ts
import type { SpindleBackendProcessContext } from 'lumiverse-spindle-types'

export default function setup(process: SpindleBackendProcessContext) {
  let counter = 0
  const intervalMs = Math.max(1000, Number((process.payload as any)?.intervalMs) || 5000)

  process.ready()

  const timer = setInterval(() => {
    counter += 1
    process.heartbeat()
    process.send({
      type: 'tick',
      count: counter,
      at: Date.now(),
    })
  }, intervalMs)

  const unsubStop = process.onStop(() => {
    clearInterval(timer)
    process.complete()
  })

  return () => {
    unsubStop()
    clearInterval(timer)
  }
}
```

## Build Note

Your extension build must emit the child entry to the exact path you pass to `spawn()`.

In the example above, `src/backend-processes/watchdog.ts` needs to build to:

```text
dist/backend-processes/watchdog.js
```

## How It Works

1. The user clicks **Start**, and the frontend sends a simple `start_loop` message to the backend.
2. The backend calls `spindle.backendProcesses.spawn(...)` with startup and heartbeat timeouts.
3. The child entry calls `process.ready()`, then emits `process.heartbeat()` on every interval tick.
4. Every tick is sent back to the parent backend runtime with `process.send(...)`, and the backend forwards a UI update with `spindle.sendToFrontend(...)`.
5. If the user clicks **Stop**, the backend requests shutdown with `spindle.backendProcesses.stop(...)`, the child receives `process.onStop(...)`, clears its timer, and calls `process.complete()`.
6. If the child freezes and stops heartbeating, the host marks it `timed_out` and terminates only that child subprocess.

## Why This Pattern Matters

This gives you host-owned kill authority for risky backend loops without unloading the whole extension runtime.

Use it when you need:

- a watchdog around potentially blocking backend code
- graceful stop/restart behavior for isolated child work
- a recoverable boundary around code that might wedge its own event loop
- parent/child backend messaging without exposing the full `spindle` API inside the child

For ordinary backend work, keep the logic in `backend.ts` and use the main `spindle.*` APIs directly.

## Related Docs

- [Backend Process Lifecycle](../backend-api/backend-processes.md)
- [Frontend Process Lifecycle](../backend-api/frontend-processes.md)
- [Runtime Modes](../getting-started/runtime.md)
