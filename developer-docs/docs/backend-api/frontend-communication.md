# Backend-to-Frontend Communication

Send arbitrary messages between your backend worker and frontend module.

## Sending to Frontend

```ts
// Targeted send — delivered only to the given user.
spindle.sendToFrontend({ type: 'update', data: { count: 42 } }, userId)

// Broadcast — delivered to every connected user (operator-scoped only).
spindle.sendToFrontend({ type: 'announcement', text: 'Server restarting' })
```

> ⚠️ **Targeted vs broadcast.** When `userId` is omitted on an
> **operator-scoped** extension the payload is broadcast to **every connected
> user**, which is rarely what you want. Always pass the originating `userId`
> when replying to a specific user. **User-scoped** extensions ignore the
> argument and always deliver to their installer.

## Receiving from Frontend

```ts
const unsub = spindle.onFrontendMessage((payload, userId) => {
  spindle.log.info(`Got from user ${userId}: ${JSON.stringify(payload)}`)
})
```

The `userId` parameter identifies which user's frontend sent the message. For user-scoped extensions this is always the owner; for operator-scoped extensions it identifies the specific connected user.

Messages are JSON-serializable objects — you can use any structure you like. A common pattern is to use a `type` field for routing, echoing the sender's `userId` back so the reply only reaches that user:

```ts
spindle.onFrontendMessage(async (payload: any, userId) => {
  switch (payload.type) {
    case 'fetch_data':
      const data = await loadData(payload.query)
      spindle.sendToFrontend({ type: 'data_result', data }, userId)
      break
    case 'save_settings':
      await spindle.storage.setJson('settings.json', payload.settings)
      spindle.sendToFrontend({ type: 'settings_saved' }, userId)
      break
  }
})
```
