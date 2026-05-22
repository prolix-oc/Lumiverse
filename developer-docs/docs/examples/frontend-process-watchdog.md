# Frontend Process Watchdog

A backend + frontend example that spawns a supervised frontend sync loop, heartbeats it, and reports lifecycle changes back into a drawer tab UI.

## `spindle.json`

```json
{
  "version": "1.0.0",
  "name": "Frontend Watchdog Demo",
  "identifier": "frontend_watchdog_demo",
  "author": "Dev",
  "github": "https://github.com/dev/frontend-watchdog-demo",
  "homepage": "https://github.com/dev/frontend-watchdog-demo",
  "permissions": [],
  "entry_backend": "dist/backend.js",
  "entry_frontend": "dist/frontend.js"
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

      const process = await spindle.frontendProcesses.spawn({
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

      await spindle.frontendProcesses.stop(processId, {
        userId,
        reason: 'user_requested',
      })
      break
    }
  }
})

spindle.frontendProcesses.onMessage((event) => {
  if ((event.payload as any)?.type !== 'tick') return

  spindle.sendToFrontend({
    type: 'watchdog_tick',
    processId: event.processId,
    at: (event.payload as any).at,
    count: (event.payload as any).count,
  }, event.userId)
})

spindle.frontendProcesses.onLifecycle((event) => {
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

spindle.log.info('Frontend watchdog demo loaded')
```

## `src/frontend.ts`

```ts
import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

export function setup(ctx: SpindleFrontendContext) {
  const tab = ctx.ui.registerDrawerTab({
    id: 'watchdog-demo',
    title: 'Watchdog Demo',
    shortName: 'Watchdog',
    description: 'Start and stop a supervised frontend loop',
    keywords: ['watchdog', 'heartbeat', 'process'],
  })

  tab.root.innerHTML = `
    <div style="padding:16px; display:grid; gap:12px;">
      <label style="display:grid; gap:6px;">
        <span>Heartbeat interval (ms)</span>
        <input data-watchdog-interval type="number" min="1000" step="500" value="5000" />
      </label>
      <div style="display:flex; gap:8px;">
        <button data-watchdog-start>Start</button>
        <button data-watchdog-stop>Stop</button>
      </div>
      <div data-watchdog-status>Status: idle</div>
      <div data-watchdog-ticks>Ticks: 0</div>
    </div>
  `

  const intervalInput = tab.root.querySelector('[data-watchdog-interval]') as HTMLInputElement | null
  const startBtn = tab.root.querySelector('[data-watchdog-start]') as HTMLButtonElement | null
  const stopBtn = tab.root.querySelector('[data-watchdog-stop]') as HTMLButtonElement | null
  const statusEl = tab.root.querySelector('[data-watchdog-status]') as HTMLDivElement | null
  const ticksEl = tab.root.querySelector('[data-watchdog-ticks]') as HTMLDivElement | null

  let tickCount = 0

  const unregisterProcess = ctx.processes.register('watchdog-loop', (process) => {
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
  })

  startBtn?.addEventListener('click', () => {
    tickCount = 0
    if (ticksEl) ticksEl.textContent = 'Ticks: 0'

    ctx.sendToBackend({
      type: 'start_loop',
      intervalMs: Number(intervalInput?.value || 5000),
    })
  })

  stopBtn?.addEventListener('click', () => {
    ctx.sendToBackend({ type: 'stop_loop' })
  })

  const unsubBackend = ctx.onBackendMessage((payload: any) => {
    if (payload?.type === 'watchdog_status' && statusEl) {
      statusEl.textContent = `Status: ${payload.state}${payload.exitReason ? ` (${payload.exitReason})` : ''}${payload.error ? ` - ${payload.error}` : ''}`
    }

    if (payload?.type === 'watchdog_tick' && ticksEl) {
      tickCount = Number(payload.count) || tickCount + 1
      ticksEl.textContent = `Ticks: ${tickCount}`
    }
  })

  return () => {
    unregisterProcess()
    unsubBackend()
    tab.destroy()
  }
}
```

## How It Works

1. The frontend registers a `watchdog-loop` handler with `ctx.processes.register(...)`.
2. The user clicks **Start**, and the frontend sends a simple `start_loop` message to the backend.
3. The backend calls `spindle.frontendProcesses.spawn(...)` with startup and heartbeat timeouts.
4. The frontend process calls `process.ready()`, then emits `process.heartbeat()` on every interval tick.
5. Every tick is sent back to the backend with `process.send(...)`, and the backend forwards a UI update with `spindle.sendToFrontend(...)`.
6. If the user clicks **Stop**, the backend requests shutdown with `spindle.frontendProcesses.stop(...)`, the frontend receives `process.onStop(...)`, clears its timer, and calls `process.complete()`.
7. If the loop freezes and stops heartbeating, the host marks it `timed_out` and emits that lifecycle event back into the backend worker.

## Why This Pattern Matters

This gives you a backend-owned lifecycle for frontend work without exposing raw browser `process.*` semantics.

Use it when you need:

- a sync loop the backend can monitor
- a frozen-script watchdog
- graceful stop/restart behavior
- per-user frontend workers with explicit lifecycle events

For ordinary one-shot UI messages, the simpler `ctx.sendToBackend()` / `spindle.sendToFrontend()` path is still the right tool.

## Related Docs

- [Backend Frontend Process Lifecycle](../backend-api/frontend-processes.md)
- [Frontend Process Lifecycle](../frontend-api/processes.md)
- [Frontend-to-Backend Communication](../frontend-api/backend-communication.md)
