# Backend-to-Frontend Communication

Send arbitrary messages between your backend worker and frontend module.

## Sending to Frontend

```ts
spindle.sendToFrontend({ type: 'update', data: { count: 42 } })
```

## Receiving from Frontend

```ts
const unsub = spindle.onFrontendMessage((payload, userId) => {
  spindle.log.info(`Got from user ${userId}: ${JSON.stringify(payload)}`)
})
```

The `userId` parameter identifies which user's frontend sent the message. For user-scoped extensions this is always the owner; for operator-scoped extensions it identifies the specific connected user.

Messages are JSON-serializable objects — you can use any structure you like. A common pattern is to use a `type` field for routing:

```ts
spindle.onFrontendMessage(async (payload: any, userId) => {
  switch (payload.type) {
    case 'fetch_data':
      const data = await loadData(payload.query)
      spindle.sendToFrontend({ type: 'data_result', data })
      break
    case 'save_settings':
      await spindle.storage.setJson('settings.json', payload.settings)
      spindle.sendToFrontend({ type: 'settings_saved' })
      break
  }
})
```
