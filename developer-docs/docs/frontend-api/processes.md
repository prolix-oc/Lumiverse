# Frontend Process Lifecycle

Register frontend handlers that can be spawned and supervised by your backend runtime.

This API is for long-lived frontend-side controllers such as sync loops, DOM observers, and route-aware coordinators. The backend starts them with `spindle.frontendProcesses.spawn(...)`; the frontend acknowledges readiness, emits heartbeats, and reacts to graceful stop requests.

No permission is required. This is a free-tier API.

## Quick Start

```ts
import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

export function setup(ctx: SpindleFrontendContext) {
  const unregister = ctx.processes.register('sync-loop', (process) => {
    let timer: ReturnType<typeof setInterval> | null = null

    process.ready()

    timer = setInterval(() => {
      process.heartbeat()
      process.send({ type: 'tick', at: Date.now() })
    }, 5000)

    const unsubStop = process.onStop(() => {
      if (timer) clearInterval(timer)
      timer = null
      process.complete()
    })

    return () => {
      unsubStop()
      if (timer) clearInterval(timer)
    }
  })

  return () => {
    unregister()
  }
}
```

## `ctx.processes.register(kind, handler)`

Register a frontend process handler under a `kind` string.

```ts
const unregister = ctx.processes.register('presence-loop', (process) => {
  process.ready()
})
```

The backend later spawns it with the same `kind`:

```ts
// backend runtime
await spindle.frontendProcesses.spawn({
  kind: 'presence-loop',
  userId,
})
```

The returned function unregisters the handler.

If your handler returns a cleanup function, Lumiverse calls it when the process is stopped, replaced, or the frontend extension unloads.

## Process Context

Your handler receives a `process` controller object.

### Properties

| Field | Type | Description |
|---|---|---|
| `processId` | `string` | Host-assigned process ID |
| `kind` | `string` | Registered process kind |
| `key` | `string?` | Optional stable dedupe key from the backend |
| `payload` | `unknown` | Arbitrary spawn payload |
| `metadata` | `Record<string, unknown>?` | Host-tracked metadata snapshot |

### `process.ready()`

Signal that startup completed successfully.

The backend `spawn()` call does not resolve until this is called.

```ts
ctx.processes.register('panel-sync', (process) => {
  attachObservers()
  process.ready()
})
```

Call it exactly once, after your process is ready to run.

### `process.heartbeat()`

Refresh the backend watchdog timer for long-lived processes.

```ts
const timer = setInterval(() => {
  process.heartbeat()
}, 5000)
```

If the backend configured `heartbeatTimeoutMs`, failing to heartbeat in time transitions the process to `timed_out`.

### `process.send(payload)`

Send a process-scoped message back to the backend runtime.

```ts
process.send({ type: 'tick', route: location.pathname })
```

The backend receives it via `spindle.frontendProcesses.onMessage(...)`.

### `process.onMessage(handler)`

Receive process-scoped messages from the backend. The backend uses `spindle.frontendProcesses.send(processId, payload)` to target specific process instances.

```ts
const unsub = process.onMessage((payload) => {
  if ((payload as any)?.type === 'set_interval') {
    updateInterval((payload as any).ms)
  }
})
```

### `process.complete(result?)`

Mark the process as finished successfully and release host tracking.

```ts
process.complete()
```

Use this when the process has done its job or after handling a stop request.

### `process.fail(error)`

Mark the process as failed.

```ts
try {
  startDangerousThing()
} catch (err) {
  process.fail(err instanceof Error ? err.message : String(err))
}
```

### `process.onStop(handler)`

Receive graceful stop requests from the backend.

```ts
const unsub = process.onStop(({ reason }) => {
  console.log('Stopping because:', reason)
  teardownLoop()
  process.complete()
})
```

The handler should clean up timers/listeners and usually call `process.complete()` when teardown is done.

## Recommended Pattern

For a long-lived process:

1. initialize resources
2. call `process.ready()`
3. emit `process.heartbeat()` on a stable cadence
4. handle backend messages with `process.onMessage(...)`
5. handle shutdown with `process.onStop(...)`
6. finish with `process.complete()` or `process.fail(...)`

## Stateless vs Stateful Messaging

Use:

- `ctx.sendToBackend()` / `ctx.onBackendMessage()` for ordinary one-shot messages
- `ctx.processes.register(...)` when the backend needs a supervised frontend-side lifecycle

## Related Docs

- [Frontend-to-Backend Communication](backend-communication.md)
- [Backend Frontend Process Lifecycle](../backend-api/frontend-processes.md)
- [Runtime Modes](../getting-started/runtime.md)
