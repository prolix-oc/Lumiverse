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

## Managed-process JSON-safe wire limits

Each WorkerHost extension runtime may have at most 16 active frontend processes and 16 active backend processes. A keyed frontend spawn with `replaceExisting: true` may replace its existing keyed process even when the frontend cap is full; otherwise a spawn at the cap is rejected.

Managed process values use a strict JSON-safe wire grammar, not arbitrary structured-clone values. A spawn `payload` and every process-scoped message payload (in either direction) may be `null`, booleans, finite numbers, strings, dense arrays, or plain string-keyed objects whose prototype is `Object.prototype` or `null`. A spawn `metadata`, when present, is instead required to be a non-null plain string-keyed object—the published `lumiverse-spindle-types@0.6.4` `metadata?: Record<string, unknown>` shape. Its nested values use the same grammar and may be `null`.

A spawn `payload` or `metadata` may be omitted, and omission is distinct from an included value. An included payload may be `null`; an included metadata root may not be `null` or `undefined` and must satisfy the plain-object shape. Explicit `undefined` is unsupported for either root, and `undefined` anywhere inside an included array or object is rejected. Plain objects may contain only own enumerable string-keyed data properties. Arrays must be dense (every index from `0` through `length - 1` is present) and may contain no extra own properties. Accessor properties, symbol-keyed properties, and non-enumerable own properties are rejected rather than ignored. Reject `bigint`, symbols, functions, non-finite numbers (`NaN`, `Infinity`, and `-Infinity`), cycles, exotic or custom prototypes, `Date`, `RegExp`, `Error`, `AggregateError`, `Map`, `Set`, boxed primitives, `ArrayBuffer`, `SharedArrayBuffer`, `DataView`, and typed arrays.

Repeated completed shared object references are allowed and counted once by identity, including when shared between `payload` and `metadata`; cycles are rejected. For one spawn, `payload` and `metadata` are separate roots that share one 256 KiB (262,144-byte) UTF-8 budget counting every string value and own property name, plus one limit of 10,000 identity-aware visited values. Each root starts at depth 0 and no path may exceed depth 32. Each array or object may contain at most 1,000 entries. Every process-scoped message has its own single-root budget with the same 256 KiB UTF-8 string-value/property-name budget, 10,000 visited values, depth 32, and 1,000-entry array/object limit.

Fixed protocol strings are capped by UTF-8 byte length: `kind` 128 bytes, `key` 256 bytes, backend `entry` 4,096 bytes, `processId` 128 bytes, and stop `reason` or failure `error` 4,096 bytes. These fixed fields are not counted against the managed value budget. Backend-worker-originated process operations first cross the worker transport as a structured clone; the host then validates values before retaining spawn values/metadata or forwarding a process message. Browser-originated frontend process lifecycle and message operations instead cross WebSocket serialization first; the host WebSocket handler authenticates and routes them, then WorkerHost applies managed validation before forwarding an accepted message to the backend worker. Browser ingress is not an initial worker structured-clone boundary. An invalid spawn operation is rejected; an invalid process message is dropped rather than delivered. These checks are not an OS-level ingress memory boundary. For canonical shared wording, see [Managed-process JSON-safe wire limits](../backend-api/backend-processes.md#managed-process-json-safe-wire-limits).

## Process Context

Your handler receives a `process` controller object.

### Properties

| Field | Type | Description |
|---|---|---|
| `processId` | `string` | Host-assigned process ID |
| `kind` | `string` | Registered process kind |
| `key` | `string?` | Optional stable dedupe key from the backend |
| `payload` | `unknown` | Optional managed-process JSON-safe spawn payload |
| `metadata` | `Record<string, unknown>?` | Optional non-null managed-process JSON-safe metadata snapshot; omitted when absent |

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

Send a managed-process JSON-safe, process-scoped message back to the backend runtime. An invalid message is dropped.

```ts
process.send({ type: 'tick', route: location.pathname })
```

The backend receives it via `spindle.frontendProcesses.onMessage(...)`.

### `process.onMessage(handler)`

Receive managed-process JSON-safe, process-scoped messages from the backend. The backend uses `spindle.frontendProcesses.send(processId, payload)` to target specific process instances; invalid messages are dropped before delivery.

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

### Stop and force cleanup

An explicit stop request through `spindle.frontendProcesses.stop(...)` is graceful. The host waits up to 5 seconds for the frontend's completion acknowledgement (`process.complete()`); if no acknowledgement arrives, it sends a forced stop and performs browser-side cleanup. Startup or heartbeat timeouts, keyed replacement, and frontend extension unload force cleanup immediately instead of waiting. A cleanup function returned by the handler runs during both graceful and forced teardown, so keep it idempotent.

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

The generic `ctx.sendToBackend()` / `ctx.onBackendMessage()` channel is not a managed process channel; it crosses the host WebSocket bridge as JSON-serializable payloads. Only process spawn `payload`/`metadata` and process-scoped messages use the strict managed-process JSON-safe limits above.

## Related Docs

- [Frontend-to-Backend Communication](backend-communication.md)
- [Backend Process Lifecycle](../backend-api/backend-processes.md)
- [Runtime Modes](../getting-started/runtime.md)
