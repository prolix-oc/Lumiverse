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

## Startup readiness

Lumiverse auto-readies legacy frontends as soon as `setup(ctx)` returns. That preserves existing extensions, but it also means startup messages can be replayed immediately after setup completes.

If your frontend keeps booting asynchronously and is not ready to receive startup traffic yet, opt into manual readiness:

```ts
export function setup(ctx: SpindleFrontendContext) {
  ctx.deferReady()

  const unsub = ctx.onBackendMessage((payload: any) => {
    // Register handlers synchronously before calling ready().
  })

  void initializeUi().finally(() => {
    ctx.ready()
  })

  return () => {
    unsub()
  }
}
```

Rules:

- Call `ctx.deferReady()` during `setup()` before it returns.
- Call `ctx.ready()` once your handlers and initial UI shell are safe to receive queued startup messages.
- If your startup flow depends on backend replies, call `ctx.ready()` as soon as those handlers are installed instead of waiting on the replies themselves.
- If you do nothing, Lumiverse falls back to legacy auto-ready behavior.
- If you call `ctx.deferReady()` but never call `ctx.ready()`, Lumiverse eventually auto-recovers and flushes the queue after a timeout.
