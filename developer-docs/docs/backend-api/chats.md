# Chats

!!! warning "Permission required: `chats`"

List, inspect, update, and delete chat sessions. This operates on chat entities (metadata, name, lifecycle). For reading and modifying individual *messages* within a chat, see [Chat Mutation](chat-mutation.md).

## Usage

```ts
// List all chats (paginated)
const { data, total } = await spindle.chats.list({ limit: 20, offset: 0 })

// List chats for a specific character
const characterChats = await spindle.chats.list({ characterId: 'char-id' })

// Get a single chat
const chat = await spindle.chats.get('chat-id')
if (chat) {
  spindle.log.info(`Chat "${chat.name}" with character ${chat.character_id}`)
}

// Get the user's currently active chat
const active = await spindle.chats.getActive()
if (active) {
  spindle.log.info(`User is in chat: ${active.name}`)
} else {
  spindle.log.info('No active chat')
}

// Update a chat's name or metadata
const updated = await spindle.chats.update('chat-id', {
  name: 'Renamed Chat',
  metadata: { custom_field: 'value' },
})

// Delete a chat (cascades all messages)
const deleted = await spindle.chats.delete('chat-id')
```

## Methods

| Method | Returns | Description |
|---|---|---|
| `list(options?)` | `Promise<{ data: ChatDTO[], total: number }>` | List chats. Options: `{ characterId?, limit?, offset? }`. Defaults: limit 50, max 200. |
| `get(chatId)` | `Promise<ChatDTO \| null>` | Get a chat by ID. Returns `null` if not found. |
| `getActive()` | `Promise<ChatDTO \| null>` | Get the user's currently active chat. Returns `null` if none is open. |
| `update(chatId, input)` | `Promise<ChatDTO>` | Update a chat's name or metadata. |
| `delete(chatId)` | `Promise<boolean>` | Delete a chat and all its messages. Returns `true` if deleted. |

## ChatDTO

```ts
{
  id: string
  character_id: string
  name: string
  metadata: Record<string, unknown>
  created_at: number   // unix epoch seconds
  updated_at: number
}
```

## ChatUpdateDTO

| Field | Type | Description |
|---|---|---|
| `name` | `string` | New chat name |
| `metadata` | `Record<string, unknown>` | Replace the chat's metadata object |

Both fields are optional. Only provided fields are updated.

## Active Chat

`getActive()` reads the `activeChatId` setting that the frontend persists whenever the user opens or closes a chat. This lets extensions discover the current chat without subscribing to events.

```ts
// React to the active chat
const active = await spindle.chats.getActive()
if (active) {
  // Combine with chat mutation to read messages
  const messages = await spindle.chat.getMessages(active.id)
  spindle.log.info(`Active chat has ${messages.length} messages`)
}
```

!!! tip "Chats vs Chat Mutation"
    - **`spindle.chats`** (this page) — CRUD on chat *sessions* (list, get, rename, delete). Permission: `chats`.
    - **`spindle.chat`** ([Chat Mutation](chat-mutation.md)) — read and modify *messages* within a chat. Permission: `chat_mutation`.

    These are separate permissions so extensions can request only the access they need.

!!! note
    For user-scoped extensions, the user context is inferred automatically. For operator-scoped extensions, the user ID is resolved from the extension context.
