# Frontend-to-Backend Communication

## `ctx.sendToBackend(payload)`

Send a message to your backend runtime.

For backend-spawned, long-lived frontend loops with `ready()`, `heartbeat()`, and graceful stop handling, use [Frontend Process Lifecycle](processes.md) instead.

```ts
ctx.sendToBackend({ type: 'fetch_data', query: 'hello' })
```

## `ctx.onBackendMessage(handler)`

Receive messages from your backend runtime.

```ts
const unsub = ctx.onBackendMessage((payload) => {
  console.log('Got from backend:', payload)
})
```

Messages are JSON-serializable objects. A common pattern is to use a `type` field for routing on both sides.

The transport is runtime-mode independent: `process`, `sandbox`, and `worker` all use the same extension messaging API.
