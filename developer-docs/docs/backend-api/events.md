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
| `MESSAGE_SWIPED` | `{ chatId, messageId, swipeId }` |
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
