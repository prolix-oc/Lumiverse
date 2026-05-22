# Frontend Process Lifecycle

Spawn and supervise long-lived frontend-side controllers from your backend runtime.

This is the structured version of backend/frontend messaging: the backend owns the lifecycle, the frontend acknowledges startup, emits heartbeats, and can send process-scoped messages back.

No permission is required. This is a free-tier API.

## When To Use This

Use `spindle.frontendProcesses` when you need frontend work that is:

- long-lived rather than one-shot
- user-scoped
- observable from the backend
- restartable or replaceable
- protected by a startup or heartbeat watchdog

Examples:

- sync loops
- watchdog-monitored DOM observers
- route-aware UI coordinators
- stateful frontend workers that need backend supervision

For simple request/response messaging, use [Frontend Communication](frontend-communication.md) instead.

## Quick Start

```ts
const process = await spindle.frontendProcesses.spawn({
  kind: 'sync-loop',
  key: `chat:${chatId}`,
  userId,
  payload: { chatId },
  startupTimeoutMs: 10_000,
  heartbeatTimeoutMs: 15_000,
  replaceExisting: true,
})

const unsubLifecycle = spindle.frontendProcesses.onLifecycle((event) => {
  if (event.processId !== process.processId) return

  if (event.state === 'timed_out') {
    spindle.log.warn(`Frontend process timed out: ${event.kind}`)
  }

  if (event.state === 'failed') {
    spindle.log.error(event.error ?? 'Frontend process failed')
  }
})

const unsubMessages = spindle.frontendProcesses.onMessage((event) => {
  if (event.processId !== process.processId) return

  if ((event.payload as any)?.type === 'tick') {
    spindle.log.info(`Tick from ${event.userId}`)
  }
})

process.send({ type: 'set_interval', ms: 2000 })

// Later
await process.stop({ reason: 'chat_changed' })
unsubLifecycle()
unsubMessages()
```

## Methods

### `spindle.frontendProcesses.spawn(options)`

Spawn a frontend process and wait for the frontend handler to call `process.ready()`.

If the frontend never acknowledges readiness before `startupTimeoutMs`, the spawn rejects and the process transitions to `timed_out`.

```ts
const process = await spindle.frontendProcesses.spawn({
  kind: 'presence-loop',
  userId,
  payload: { chatId: 'abc' },
})
```

| Field | Type | Default | Description |
|---|---|---|---|
| `kind` | `string` | required | Frontend handler key registered with `ctx.processes.register(kind, handler)` |
| `key` | `string` | — | Optional stable dedupe key |
| `payload` | `unknown` | — | Arbitrary spawn payload delivered to the frontend handler |
| `metadata` | `Record<string, unknown>` | — | Host-tracked metadata snapshot |
| `userId` | `string` | installer for user-scoped extensions | Required for operator-scoped extensions |
| `startupTimeoutMs` | `number` | `15000` | Time budget for `process.ready()` |
| `heartbeatTimeoutMs` | `number` | `15000` | Max allowed gap between heartbeats after ready |
| `replaceExisting` | `boolean` | `false` | Replace an existing process with the same `kind` + `key` for the target user |

The returned handle exposes:

| Property / Method | Returns | Description |
|---|---|---|
| `processId` | `string` | Host-assigned process ID |
| `kind` | `string` | Spawned frontend kind |
| `key` | `string?` | Optional stable key |
| `info` | `FrontendProcessInfoDTO` | Snapshot returned at spawn time |
| `send(payload)` | `void` | Send a process-scoped message to the frontend instance |
| `stop(options?)` | `Promise<void>` | Request graceful termination |
| `refresh()` | `Promise<FrontendProcessInfoDTO \| null>` | Fetch the latest snapshot |

### `spindle.frontendProcesses.list(filter?)`

List tracked frontend processes for this extension.

```ts
const running = await spindle.frontendProcesses.list({
  userId,
  kind: 'sync-loop',
  state: 'running',
})
```

### `spindle.frontendProcesses.get(processId)`

Fetch one process by ID.

```ts
const info = await spindle.frontendProcesses.get(processId)
if (info?.state === 'running') {
  spindle.log.info(`Heartbeat at ${info.lastHeartbeatAt}`)
}
```

### `spindle.frontendProcesses.send(processId, payload, userId?)`

Send a process-scoped message directly to a running frontend process.

```ts
spindle.frontendProcesses.send(processId, {
  type: 'config_update',
  config: { mode: 'fast' }
});
```

### `spindle.frontendProcesses.stop(processId, options?)`

Request graceful termination for a process.

```ts
await spindle.frontendProcesses.stop(processId, {
  userId,
  reason: 'panel_closed',
})
```

### `spindle.frontendProcesses.onLifecycle(handler)`

Receive lifecycle transitions for every tracked frontend process owned by the extension.

```ts
const unsub = spindle.frontendProcesses.onLifecycle((event) => {
  spindle.log.info(`${event.kind} -> ${event.state}`)
})
```

Lifecycle states:

- `starting`
- `running`
- `stopping`
- `stopped`
- `completed`
- `failed`
- `timed_out`

Common exit reasons:

- `completed`
- `failed`
- `stopped`
- `timed_out`
- `frontend_unloaded`
- `backend_unloaded`
- `replaced`

### `spindle.frontendProcesses.onMessage(handler)`

Receive process-scoped messages sent from the frontend side.

```ts
const unsub = spindle.frontendProcesses.onMessage((event) => {
  if (event.processId !== processId) return
  spindle.log.info(JSON.stringify(event.payload))
})
```

## Multi-User Behavior

- **User-scoped extensions** always target their installer.
- **Operator-scoped extensions** must pass `userId` when spawning user-specific processes.
- `replaceExisting` is scoped by `userId + kind + key`.

## Watchdog Model

`spawn()` waits for the frontend to call `process.ready()`.

After that, the host expects periodic `process.heartbeat()` calls if `heartbeatTimeoutMs` is greater than `0`.

If the frontend:

- never becomes ready, the process times out during startup
- stops heartbeating, the process transitions to `timed_out`
- unloads because the extension frontend is torn down, the process transitions to `frontend_unloaded`

## Recommended Pattern

Use ordinary backend/frontend messaging for stateless UI requests, and use frontend processes for stateful loops.

Typical split:

- `spindle.sendToFrontend()` / `ctx.sendToBackend()` for one-shot messages
- `spindle.frontendProcesses.spawn()` for supervised, user-scoped long-running work

## Related Docs

- [Frontend Process Lifecycle](../frontend-api/processes.md)
- [Frontend Communication](frontend-communication.md)
- [Frontend-to-Backend Communication](../frontend-api/backend-communication.md)
