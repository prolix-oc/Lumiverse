# Backend Process Lifecycle

Spawn and supervise isolated backend subprocesses from your main backend runtime.

This is the backend-to-backend counterpart to [Frontend Process Lifecycle](frontend-processes.md): the host owns the child lifecycle, the child acknowledges startup, emits heartbeats, and exchanges process-scoped messages with its parent backend runtime.

No permission is required. This is a free-tier API.

## When To Use This

Use `spindle.backendProcesses` when one slice of backend logic should run outside the main extension runtime because it is:

- long-lived rather than one-shot
- potentially blocking or risky
- observable from the parent backend runtime
- restartable or replaceable
- protected by a startup or heartbeat watchdog

Examples:

- watchdog-monitored parsers or transforms
- risky loops that could wedge a worker-thread runtime
- isolated background controllers with explicit stop behavior
- backend-side supervisors that should be killable without unloading the whole extension

For normal backend logic, keep using your main `backend.ts`. For frontend work, use [Frontend Process Lifecycle](frontend-processes.md).

## Important Constraints

- `entry` must point at a built JavaScript file under `dist/`
- the child entry must export either a default function or a named `run` function
- the child entry does **not** receive the full `spindle` API
- child and parent communicate only through process-scoped messaging

That narrower surface is intentional: it keeps the isolation boundary small and lets the host terminate a wedged child without having to proxy the entire backend API through a second runtime.

## Quick Start

```ts
const process = await spindle.backendProcesses.spawn({
  entry: 'dist/backend-processes/watchdog.js',
  kind: 'watchdog',
  key: `chat:${chatId}`,
  userId,
  payload: { chatId },
  startupTimeoutMs: 10_000,
  heartbeatTimeoutMs: 15_000,
  replaceExisting: true,
})

const unsubLifecycle = spindle.backendProcesses.onLifecycle((event) => {
  if (event.processId !== process.processId) return

  if (event.state === 'timed_out') {
    spindle.log.warn(`Backend process timed out: ${event.kind}`)
  }

  if (event.state === 'failed') {
    spindle.log.error(event.error ?? 'Backend process failed')
  }
})

const unsubMessages = spindle.backendProcesses.onMessage((event) => {
  if (event.processId !== process.processId) return

  spindle.log.info(JSON.stringify(event.payload))
})

process.send({ type: 'start' })

// Later
await process.stop({ reason: 'chat_changed' })
unsubLifecycle()
unsubMessages()
```

## Child Entry Shape

The child entry receives a `process` context object:

```ts
export default function (process) {
  process.ready()

  const timer = setInterval(() => {
    process.heartbeat()
    process.send({ type: 'tick', at: Date.now() })
  }, 1000)

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

The context exposes:

| Method / Property | Returns | Description |
|---|---|---|
| `processId` | `string` | Host-assigned process ID |
| `entry` | `string` | Spawned built entry path |
| `kind` | `string` | Logical process kind |
| `key` | `string?` | Optional stable dedupe key |
| `payload` | `unknown` | Spawn payload from the parent runtime |
| `metadata` | `Record<string, unknown>?` | Host-tracked metadata snapshot |
| `userId` | `string?` | Target user for operator-scoped spawns |
| `ready()` | `void` | Acknowledge startup success |
| `heartbeat()` | `void` | Refresh the host-side watchdog |
| `send(payload)` | `void` | Send a process-scoped message to the parent runtime |
| `onMessage(handler)` | `() => void` | Receive process-scoped messages from the parent runtime |
| `complete()` | `void` | Mark the child as completed |
| `fail(error)` | `void` | Mark the child as failed |
| `onStop(handler)` | `() => void` | React to graceful stop requests from the parent |

## Methods

### `spindle.backendProcesses.spawn(options)`

Spawn an isolated backend subprocess and wait for the child entry to call `process.ready()`.

If the child never acknowledges readiness before `startupTimeoutMs`, the spawn rejects and the process transitions to `timed_out`.

```ts
const process = await spindle.backendProcesses.spawn({
  entry: 'dist/backend-processes/indexer.js',
  kind: 'indexer',
  userId,
  payload: { databankId: 'abc' },
})
```

| Field | Type | Default | Description |
|---|---|---|---|
| `entry` | `string` | required | Built child entry under `dist/` |
| `kind` | `string` | `entry` | Logical label used for filtering and dedupe |
| `key` | `string` | — | Optional stable dedupe key |
| `payload` | `unknown` | — | Arbitrary spawn payload delivered to the child entry |
| `metadata` | `Record<string, unknown>` | — | Host-tracked metadata snapshot |
| `userId` | `string` | installer for user-scoped extensions | Required for operator-scoped extensions |
| `startupTimeoutMs` | `number` | `15000` | Time budget for `process.ready()` |
| `heartbeatTimeoutMs` | `number` | `15000` | Max allowed gap between heartbeats after ready |
| `replaceExisting` | `boolean` | `false` | Replace an existing process with the same `kind` + `key` for the target user |

The returned handle exposes:

| Property / Method | Returns | Description |
|---|---|---|
| `processId` | `string` | Host-assigned process ID |
| `entry` | `string` | Spawned built entry path |
| `kind` | `string` | Logical process kind |
| `key` | `string?` | Optional stable key |
| `info` | `BackendProcessInfoDTO` | Snapshot returned at spawn time |
| `send(payload)` | `void` | Send a process-scoped message to the child subprocess |
| `stop(options?)` | `Promise<void>` | Request graceful termination |
| `refresh()` | `Promise<BackendProcessInfoDTO \| null>` | Fetch the latest snapshot |

### `spindle.backendProcesses.list(filter?)`

List tracked backend subprocesses for this extension.

```ts
const running = await spindle.backendProcesses.list({
  userId,
  kind: 'indexer',
  state: 'running',
})
```

### `spindle.backendProcesses.get(processId)`

Fetch one process by ID.

```ts
const info = await spindle.backendProcesses.get(processId)
if (info?.state === 'running') {
  spindle.log.info(`Heartbeat at ${info.lastHeartbeatAt}`)
}
```

### `spindle.backendProcesses.send(processId, payload, userId?)`

Send a process-scoped message directly to a running backend subprocess.

```ts
spindle.backendProcesses.send(processId, {
  type: 'config_update',
  config: { mode: 'fast' }
});
```

### `spindle.backendProcesses.stop(processId, options?)`

Request graceful termination for a process.

```ts
await spindle.backendProcesses.stop(processId, {
  userId,
  reason: 'panel_closed',
})
```

### `spindle.backendProcesses.onLifecycle(handler)`

Receive lifecycle transitions for every tracked backend subprocess owned by the extension.

```ts
const unsub = spindle.backendProcesses.onLifecycle((event) => {
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
- `backend_unloaded`
- `replaced`

### `spindle.backendProcesses.onMessage(handler)`

Receive process-scoped messages sent from the child subprocess.

```ts
const unsub = spindle.backendProcesses.onMessage((event) => {
  if (event.processId !== processId) return
  spindle.log.info(JSON.stringify(event.payload))
})
```

## Multi-User Behavior

- **User-scoped extensions** always target their installer.
- **Operator-scoped extensions** must pass `userId` when spawning user-specific backend processes.
- `replaceExisting` is scoped by `userId + kind + key`.

## Watchdog Model

`spawn()` waits for the child entry to call `process.ready()`.

After that, the host expects periodic `process.heartbeat()` calls if `heartbeatTimeoutMs` is greater than `0`.

If the child:

- never becomes ready, the process times out during startup
- stops heartbeating, the host terminates it and marks it `timed_out`
- exits unexpectedly, the process transitions to `failed`

This is the key distinction from ordinary in-process backend code: the host can still fire watchdog timers and kill the child even if the child has blocked its own event loop.

## Recommended Pattern

Use your main backend runtime for normal `spindle.*` work, and move only narrowly risky or long-running loops into `spindle.backendProcesses` child entries.

Typical split:

- `backend.ts` for events, storage, Lumiverse API calls, and orchestration
- `spindle.backendProcesses.spawn()` for watchdog-supervised child work that must remain killable

## Related Docs

- [Runtime Modes](../getting-started/runtime.md)
- [Frontend Process Lifecycle](frontend-processes.md)
- [Backend Communication](../frontend-api/backend-communication.md)
- [Backend Process Watchdog](../examples/backend-process-watchdog.md)
