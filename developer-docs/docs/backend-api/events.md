# Events

Subscribe to any Lumiverse lifecycle event. Returns an unsubscribe function.

```ts
// Subscribe
const unsub = spindle.on('MESSAGE_SENT', (payload) => {
  spindle.log.info(`Message sent in chat ${payload.chatId}`)
})

// Unsubscribe later
unsub()
```

## Available Events

### Chat Lifecycle

| Event | Payload |
|-------|---------|
| `MESSAGE_SENT` | `{ chatId, message }` |
| `MESSAGE_EDITED` | `{ chatId, message }` |
| `MESSAGE_DELETED` | `{ chatId, messageId }` |
| `MESSAGE_SWIPED` | `MessageSwipedPayloadDTO` — see below |
| `CHAT_CHANGED` | `{ chatId }` |
| `CHARACTER_MESSAGE_RENDERED` | `{ chatId, messageId }` |
| `USER_MESSAGE_RENDERED` | `{ chatId, messageId }` |

### Generation

!!! warning "Permission required: `generation`"
    Subscribing to generation events requires the `generation` permission. Without it, the subscription is rejected and a `permission_denied` notification is sent to the extension.

| Event | Typed Payload | Description |
|-------|---------------|-------------|
| `GENERATION_STARTED` | `GenerationStartedPayloadDTO` | A generation has begun |
| `STREAM_TOKEN_RECEIVED` | `StreamTokenPayloadDTO` | A token was received from the LLM |
| `GENERATION_ENDED` | `GenerationEndedPayloadDTO` | Generation completed (success or error) |
| `GENERATION_STOPPED` | `GenerationStoppedPayloadDTO` | User stopped the generation |

These events have typed overloads — payloads are automatically narrowed when using `lumiverse-spindle-types`:

```ts
spindle.on('STREAM_TOKEN_RECEIVED', (payload) => {
  // payload: StreamTokenPayloadDTO — fully typed
  console.log(payload.token, payload.seq, payload.type)
})
```

See [Generation > Stream Observation](generation.md#stream-observation) for the high-level `observe()` helper and full payload field reference.

### Swipe Events

`MESSAGE_SWIPED` is emitted by all four swipe operations (`addSwipe`, `updateSwipe`, `deleteSwipe`, `cycleSwipe`). The `action` discriminator and the `swipeId` field let you tell them apart and maintain swipe-keyed state without diffing the `swipes` array.

```ts
spindle.on('MESSAGE_SWIPED', (payload) => {
  // payload: MessageSwipedPayloadDTO — fully typed
  switch (payload.action) {
    case 'added':
      // payload.swipeId === payload.message.swipe_id (the new variant)
      break
    case 'updated':
      // payload.swipeId is the edited slot (may not be the active one)
      break
    case 'deleted':
      // payload.swipeId is the removed slot (no longer in message.swipes)
      // payload.previousSwipeId tells you the active slot before deletion
      if (payload.previousSwipeId === payload.swipeId) {
        // the active swipe was the one removed
      }
      break
    case 'navigated':
      // payload.swipeId === payload.message.swipe_id (the destination)
      // payload.previousSwipeId tells you which direction the user came from
      break
  }
})
```

| Field | Type | Notes |
|-------|------|-------|
| `chatId` | `string` | |
| `message` | `ChatMessageDTO` | The full message after the mutation. Use `message.swipes[]` for the current swipe set. |
| `action` | `'added' \| 'updated' \| 'deleted' \| 'navigated'` | Discriminator for the swipe operation. |
| `swipeId` | `number` | The swipe index this event concerns. For `deleted`, the slot is no longer present in `message.swipes`; for the other actions, `message.swipes[swipeId]` is the affected variant. |
| `previousSwipeId` | `number?` | Active swipe index *before* the change. Present for `navigated` and `deleted`; omitted for `added` and `updated`. |

!!! note "Backwards compatibility"
    Subscribers that only read `payload.chatId` and `payload.message` keep working unchanged — the discriminator fields are purely additive.

### Entities

| Event | Payload |
|-------|---------|
| `CHARACTER_EDITED` | `{ id, character }` |
| `CHARACTER_DELETED` | `{ id }` |
| `CHARACTER_DUPLICATED` | `{ id, newId }` |
| `CHARACTER_AVATAR_CHANGED` | `{ chatId, characterId, imageId }` |
| `PERSONA_CHANGED` | `{ persona }` |

### Settings

| Event | Payload |
|-------|---------|
| `SETTINGS_UPDATED` | `{ key, value }` |
| `PRESET_CHANGED` | `{ presetId }` |
| `CONNECTION_PROFILE_LOADED` | `{ connectionId }` |
| `MAIN_API_CHANGED` | `{ provider }` |
| `WORLD_INFO_ACTIVATED` | `{ entries }` |

### Images

| Event | Payload |
|-------|---------|
| `IMAGE_UPLOADED` | `{ imageId }` |
| `IMAGE_DELETED` | `{ imageId }` |

### Expressions

| Event | Payload |
|-------|---------|
| `EXPRESSION_CHANGED` | `{ chatId, characterId, label, imageId }` |

### Spindle Extensions

| Event | Payload |
|-------|---------|
| `SPINDLE_THEME_OVERRIDES` | `{ extensionId, extensionName, overrides }` — `overrides` is `{ variables: Record<string, string> }` or `null` when cleared |
| `SPINDLE_EXTENSION_LOADED` | `{ extensionId }` |
| `SPINDLE_EXTENSION_UNLOADED` | `{ extensionId }` |
| `SPINDLE_EXTENSION_ERROR` | `{ extensionId, error }` |

### Permissions

| Event | Payload |
|-------|---------|
| `PERMISSION_CHANGED` | `{ permission, granted, allGranted }` — fired when a permission is granted or revoked at runtime. See [Permissions](../getting-started/permissions.md#reacting-to-permission-changes) for usage. |
