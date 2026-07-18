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

The loader invokes `setup(ctx)` before completing the frontend load. `setup` may return a cleanup function directly or a `Promise` resolving to `void` or a cleanup function; the loader awaits a returned promise before the load settles. Startup-message delivery is separately controlled by `ctx.ready()` and `ctx.deferReady()`.

```ts
export async function setup(ctx: SpindleFrontendContext) {
  ctx.deferReady()

  const unsub = ctx.onBackendMessage((payload: any) => {
    // Install handlers synchronously before calling ready().
  })

  await initializeUi()
  ctx.ready()

  return () => {
    unsub()
  }
}
```

Rules:

- Call `ctx.deferReady()` during `setup()` before setup settles when asynchronous initialization must keep startup messages queued.
- Call `ctx.ready()` after handlers and the initial UI shell are safe to receive queued startup traffic. `ready()` is idempotent, and it may be called before an asynchronous setup promise settles once those handlers are safe.
- If `setup()` does not call `deferReady()`, the loader auto-readies only after setup has settled successfully. This preserves legacy synchronous setup behavior while still awaiting asynchronous setup.
- If setup throws or its returned promise rejects, the load rejects and the host runs the extension's teardown/cleanup. The extension is not auto-readied.
- The host applies a bounded 10-second readiness deadline. If `deferReady()` was used but `ready()` is not called in time, the readiness promise rejects and the frontend is unloaded. Queued startup messages are discarded; the host does not auto-recover by flushing them.
- If startup depends on backend replies, call `ready()` as soon as the reply handlers are installed rather than waiting for those replies.
