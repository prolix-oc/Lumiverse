# Shared RPC Pool

Expose lightweight cross-extension state behind stable endpoint names.

No permission is required. This is a free-tier API.

Use `spindle.rpcPool` when one extension needs to publish the latest value for some state and other extensions need to read it without sharing direct in-memory references across the process isolation boundary.

## Endpoint Rules

- every readable endpoint is fully qualified as `<extension_id>.<channel>`
- owner-side methods accept either a bare channel suffix like `status.current` or a fully-qualified endpoint
- the host always normalizes owner endpoints so they stay under the current extension's prefix
- reader-side `read()` requires a fully-qualified endpoint
- invalid endpoint names reject cleanly
- reads against missing or unregistered endpoints reject cleanly

Channel segments after the extension ID may contain lowercase letters, numbers, `_`, and `-`.

## Quick Start

```ts
// Publisher extension
const statusEndpoint = spindle.rpcPool.sync('status.current', {
  online: true,
  updatedAt: Date.now(),
})

spindle.rpcPool.handle('status.live', async ({ requesterExtensionId }) => {
  return {
    requestedBy: requesterExtensionId,
    online: true,
    updatedAt: Date.now(),
  }
})

spindle.log.info(`Published ${statusEndpoint}`)

// Reader extension
const current = await spindle.rpcPool.read<{
  online: boolean
  updatedAt: number
}>('publisher_ext.status.current')
```

## Two Modes

### Sync Mode

`sync()` stores the latest value in the host-side shared registry.

Use this when:

- the value changes occasionally
- readers should get the newest snapshot immediately
- you do not need per-request logic

```ts
spindle.rpcPool.sync('presence.state', {
  activeChatId,
  openPanel,
  ts: Date.now(),
})
```

Each call replaces the previous value for that endpoint.

### On-Demand Mode

`handle()` registers a callback that runs when another extension reads the endpoint.

Use this when:

- computing the value is expensive
- the result should be generated at read time
- you want to tailor the response to the requesting extension

```ts
spindle.rpcPool.handle('tokens.estimate', async ({ requesterExtensionId }) => {
  const estimate = await spindle.tokens.countText('hello world')

  return {
    requesterExtensionId,
    total: estimate.total_tokens,
  }
}, { requires: [] })
```

Registering a handler replaces any previously synced value for the same endpoint. Calling `sync()` later replaces the handler again.

## Methods

## Permission Delegation

By default, shared RPC keeps the legacy safe behavior: a reader must have every gated permission currently granted to the endpoint owner. This prevents an extension from using another extension as a confused deputy.

For endpoints that intentionally expose a narrower surface, pass an explicit policy:

```ts
spindle.rpcPool.sync('presence.state', status, { requires: [] })

spindle.rpcPool.handle('images.caption', async () => {
  // Gated API calls inside this handler are limited to the declared permissions.
  return await buildCaption()
}, { requires: ['images'] })
```

Policy rules:

- omit the policy to require full owner-permission inheritance
- `requires: []` makes the endpoint readable without delegating gated permissions
- `requires: ['images']` requires both owner and requester to have `images`
- on-demand handlers run with only the declared permissions, so unrelated owner permissions do not bleed into the request

### `spindle.rpcPool.sync(endpoint, value, policy?)`

Publish the latest value for an endpoint.

```ts
const endpoint = spindle.rpcPool.sync('status.current', { ok: true }, { requires: [] })
// endpoint === 'my_extension.status.current'
```

| Parameter | Type | Description |
|---|---|---|
| `endpoint` | `string` | Bare channel suffix or fully-qualified owned endpoint |
| `value` | `unknown` | Structured-cloneable value to expose to readers |
| `policy` | `{ requires?: string[] }` | Optional read policy. Omit for legacy owner-permission inheritance. |

Returns the fully-qualified endpoint string.

### `spindle.rpcPool.handle(endpoint, handler, policy?)`

Register an on-demand endpoint handler.

```ts
spindle.rpcPool.handle('status.live', async ({ requesterExtensionId, effectivePermissions }) => {
  return { requesterExtensionId, now: Date.now() }
}, { requires: [] })
```

The handler receives:

| Field | Type | Description |
|---|---|---|
| `endpoint` | `string` | Fully-qualified endpoint being read |
| `requesterExtensionId` | `string` | Identifier of the extension performing the read |
| `effectivePermissions` | `readonly string[]` | Gated permissions available to this delegated handler call |

Returns the fully-qualified endpoint string.

If the handler throws, the reader receives a rejected promise with that error message.

### `spindle.rpcPool.read(endpoint)`

Read a value from another extension.

```ts
const result = await spindle.rpcPool.read<{ ok: boolean }>('publisher_ext.status.current')
```

| Parameter | Type | Description |
|---|---|---|
| `endpoint` | `string` | Fully-qualified endpoint in the form `<extension_id>.<channel>` |

This rejects when:

- the endpoint name is invalid
- the target endpoint has not been registered
- the target handler throws
- the target handler times out

### `spindle.rpcPool.unregister(endpoint)`

Remove an endpoint owned by the current extension.

```ts
spindle.rpcPool.unregister('status.current')
```

Owner-side input follows the same normalization rules as `sync()` and `handle()`.

## Lifecycle Notes

- shared RPC endpoints live in the host, not inside your worker's memory
- all endpoints owned by an extension are removed automatically when that extension unloads
- this is an in-memory sharing mechanism, not persistent storage

If you need durable state, keep the source of truth in `spindle.storage`, `spindle.userStorage`, or another persisted system and use `spindle.rpcPool` as the current-process sharing layer.

## Patterns

### Publish Latest Snapshot

```ts
async function refreshStatus() {
  const status = await buildStatusSnapshot()
  spindle.rpcPool.sync('status.current', status)
}
```

### Combine Persistence With Fast Reads

```ts
async function publishConfig(userId: string) {
  const config = await spindle.userStorage.getJson('config.json', {
    fallback: { enabled: false },
    userId,
  })

  spindle.rpcPool.sync('config.latest', config)
}
```

### Graceful Reader Fallback

```ts
async function tryReadPublisherState() {
  try {
    return await spindle.rpcPool.read('publisher_ext.status.current')
  } catch (err) {
    spindle.log.warn(`Shared RPC unavailable: ${(err as Error).message}`)
    return null
  }
}
```
