# Frontend-to-Backend Communication

## `ctx.sendToBackend(payload)`

Send a message to your backend worker.

```ts
ctx.sendToBackend({ type: 'fetch_data', query: 'hello' })
```

## `ctx.onBackendMessage(handler)`

Receive messages from your backend worker.

```ts
const unsub = ctx.onBackendMessage((payload) => {
  console.log('Got from backend:', payload)
})
```

Messages are JSON-serializable objects. A common pattern is to use a `type` field for routing on both sides.
