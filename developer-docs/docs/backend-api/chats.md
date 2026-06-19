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

You can also react to chat switches in real time by subscribing to the `CHAT_SWITCHED` event:

```ts
spindle.on('CHAT_SWITCHED', (payload) => {
  if (payload.chatId) {
    spindle.log.info(`User switched to chat ${payload.chatId}`)
  } else {
    spindle.log.info('User returned to the home screen')
  }
})
```

```ts
// React to the active chat
const active = await spindle.chats.getActive()
if (active) {
  // Combine with chat mutation to read messages
  const messages = await spindle.chat.getMessages(active.id)
  spindle.log.info(`Active chat has ${messages.length} messages`)
}
```

---

## Chat Memories

Retrieve long-term memory chunks for a chat via vector search. This is the same memory system that powers the `{{memories}}` macro during prompt assembly — semantic search over vectorized chat history using embeddings.

### `spindle.chats.getMemories(chatId, options?)`

```ts
const memories = await spindle.chats.getMemories('chat-id')

if (memories.enabled && memories.count > 0) {
  spindle.log.info(`Retrieved ${memories.count} memory chunks`)
  spindle.log.info(`Available: ${memories.chunksAvailable}, Pending: ${memories.chunksPending}`)

  for (const chunk of memories.chunks) {
    spindle.log.info(`Score: ${chunk.score} — ${chunk.content.slice(0, 80)}...`)
  }

  // The formatted string is ready to inject (uses the user's template settings)
  spindle.log.info(`Formatted output:\n${memories.formatted}`)
} else {
  spindle.log.info('Chat memory is not enabled or no chunks available')
}
```

Override the number of chunks retrieved with `topK`:

```ts
// Get the top 8 most relevant memories instead of the default (usually 4)
const memories = await spindle.chats.getMemories('chat-id', { topK: 8 })
```

### Options

| Field | Type | Description |
|---|---|---|
| `topK` | `number` | Override the number of chunks to retrieve (default comes from user's chat memory settings, usually 4). Range: 1-24. |
| `userId` | `string` | For operator-scoped extensions only. |

### ChatMemoryResultDTO

| Field | Type | Description |
|---|---|---|
| `chunks` | `ChatMemoryChunkDTO[]` | The retrieved memory chunks, sorted by relevance. |
| `formatted` | `string` | Pre-formatted output using the user's `memoryHeaderTemplate` and `chunkTemplate` settings. Ready to inject. |
| `count` | `number` | Number of chunks retrieved. |
| `enabled` | `boolean` | Whether chat memory is enabled (requires embedding config + vectorized chat messages). |
| `queryPreview` | `string` | Truncated query text built from recent messages (for debugging). |
| `settingsSource` | `string` | `"global"` or `"per_chat"` — where the memory settings came from. |
| `chunksAvailable` | `number` | Total vectorized chunks in the store for this chat. |
| `chunksPending` | `number` | Chunks awaiting vectorization. If > 0, results may be incomplete. |
| `retrievalMode` | `string?` | How chunks were retrieved: `"vector"` (real vector/hybrid search) or `"recency"` (fallback, e.g. the query embedding failed). Absent until the cache is populated. |

### ChatMemoryChunkDTO

| Field | Type | Description |
|---|---|---|
| `content` | `string` | The chunk text (concatenated messages from a conversation segment). |
| `score` | `number \| null` | Vector distance (lower = more similar). `null` for keyword-only or recency-fallback hits, which have no vector distance — do not treat a missing score as a perfect (zero-distance) match. |
| `metadata` | `Record<string, unknown>` | Chunk metadata (may include `startIndex`, `endIndex`, etc.). |

!!! note "Prerequisites"
    Chat memories require the user to have embedding/vectorization configured (an embedding provider with an API key) and `vectorize_chat_messages` enabled. When not configured, the method returns `{ enabled: false, chunks: [], count: 0, ... }` without error.

!!! tip "Memories vs Chat Mutation"
    - **`getMemories()`** — retrieves semantically relevant *past* conversation segments via vector search. Read-only, no side effects.
    - **`spindle.chat.getMessages()`** ([Chat Mutation](chat-mutation.md)) — returns the full raw message list for a chat.

!!! tip "Need more than retrieval?"
    `getMemories()` is the lightweight entry point under the `chats` permission. The richer surface — listing vectorized chunks, warming a chat, invalidating the cache, plus the full Memory Cortex (entities, relations, vaults, consolidations, salience) — lives under [`spindle.memories`](memories.md) and the dedicated `memories` permission. The same retrieval call is mirrored there as `spindle.memories.chatMemory.get()`.

---

!!! tip "Chats vs Chat Mutation"
    - **`spindle.chats`** (this page) — CRUD on chat *sessions* (list, get, rename, delete). Permission: `chats`.
    - **`spindle.chat`** ([Chat Mutation](chat-mutation.md)) — read and modify *messages* within a chat. Permission: `chat_mutation`.

    These are separate permissions so extensions can request only the access they need.

!!! note
    For user-scoped extensions, the user context is inferred automatically. For operator-scoped extensions, the user ID is resolved from the extension context.
