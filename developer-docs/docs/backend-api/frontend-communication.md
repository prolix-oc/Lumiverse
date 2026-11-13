# Backend-to-Frontend Communication

Send arbitrary messages between your backend runtime and frontend module.

For supervised, long-lived frontend work with startup acknowledgement and heartbeat watchdogs, use [Frontend Process Lifecycle](frontend-processes.md) instead.

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

## Replying to the originating document

Hosts advertising `spindle.host.capabilities['frontend-session-routing-v1'] >= 1` pass a third `frontendSessionId` argument to the message handler. It identifies one loaded browser document and changes on reload. To return a result only to that document:

```ts
spindle.onFrontendMessage((payload, userId, frontendSessionId) => {
  spindle.sendToFrontend({ type: 'result', data: payload }, userId, { frontendSessionId })
})
```

When the identifier is present, the host delivers only to that user's matching connection. It never redirects a missing connection to another document. Operator-scoped extensions must also supply `userId`; a send without a resolved user is dropped without a closure event. A failed targeted send with a resolved user reports `FRONTEND_SESSION_CLOSED` to the backend worker; disconnection also publishes that event with `{ frontendSessionId }`. Pending operations should stop rather than wait for a reply from a different document. Omitting the option preserves existing user-targeted or broadcast behavior.

`frontend-session-origin-v1` supplies the host-selected execution document in generation contexts and lifecycle events. Generation and preview callers need no routing header or identifier. The most recently connected main frontend for the authenticated account owns new work; widget windows cannot become execution owners. Reconnecting an older document preserves its existing priority. A generation or preview keeps its selected document until completion and never retries on another document after disconnect. Queued Edit and Send work selects a frontend when dispatch starts; no document identifier is persisted in its outbox. When no eligible frontend is connected, the identifier is absent and an extension requiring frontend execution must report that it is unavailable.

The identifier is routing metadata scoped to an authenticated user, not an authentication token or a lock across devices. Reconnecting the same document replaces its old socket without changing its identity. Another document, including a reload, cannot take over its pending execution.

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
