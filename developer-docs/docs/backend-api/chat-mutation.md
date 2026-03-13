# Chat Mutation

!!! warning "Permission required: `chat_mutation`"

Read and modify chat messages directly. Use this for extensions that need to inject context, annotate messages, or manage conversation flow programmatically.

## Usage

```ts
// Read all messages in a chat
const messages = await spindle.chat.getMessages(chatId)
// [{ id, role, content, metadata }, ...]

// Append a new message
const { id } = await spindle.chat.appendMessage(chatId, {
  role: 'system',
  content: '[Extension note] Scene context updated.',
  metadata: { source: 'my_extension' },
})

// Update an existing message
await spindle.chat.updateMessage(chatId, messageId, {
  content: 'Updated content here.',
  metadata: { edited_by: 'my_extension' },
})

// Delete a message
await spindle.chat.deleteMessage(chatId, messageId)
```

## Methods

| Method | Returns | Description |
|---|---|---|
| `getMessages(chatId)` | `Promise<ChatMessage[]>` | Get all messages in a chat |
| `appendMessage(chatId, message)` | `Promise<{ id: string }>` | Add a new message. Fields: `{ role, content, metadata? }` |
| `updateMessage(chatId, messageId, patch)` | `Promise<void>` | Edit a message. Patch: `{ content?, metadata? }` |
| `deleteMessage(chatId, messageId)` | `Promise<void>` | Remove a message |

## ChatMessage

```ts
{
  id: string
  role: "system" | "user" | "assistant"
  content: string
  metadata?: Record<string, unknown>
}
```

## Role Mapping

Messages created via `appendMessage` use the `role` field to set `is_user` and `name`:

| Role | `is_user` | `name` |
|------|-----------|--------|
| `"user"` | `true` | From active persona |
| `"assistant"` | `false` | From chat's character |
| `"system"` | `false` | `"System"` |

Extension metadata is stored in the message's `extra.spindle_metadata` field.
