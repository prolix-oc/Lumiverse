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

// Hide a message from chat memory embeddings
await spindle.chat.setMessageHidden(chatId, messageId, true)

// Bulk-hide a batch of messages (capped at 500 per call)
await spindle.chat.setMessagesHidden(chatId, [id1, id2, id3], true)

// Read the hidden flag for a single message
const isHidden = await spindle.chat.isMessageHidden(chatId, messageId)
```

## Methods

| Method | Returns | Description |
|---|---|---|
| `getMessages(chatId)` | `Promise<ChatMessage[]>` | Get all messages in a chat |
| `appendMessage(chatId, message)` | `Promise<{ id: string }>` | Add a new message. Fields: `{ role, content, metadata? }` |
| `updateMessage(chatId, messageId, patch)` | `Promise<void>` | Edit a message. Patch: `{ content?, metadata? }` |
| `deleteMessage(chatId, messageId)` | `Promise<void>` | Remove a message |
| `setMessageHidden(chatId, messageId, hidden)` | `Promise<void>` | Toggle the `hidden` flag on one message |
| `setMessagesHidden(chatId, messageIds, hidden)` | `Promise<void>` | Bulk variant. Up to 500 IDs per call. |
| `isMessageHidden(chatId, messageId)` | `Promise<boolean>` | Read the current hidden flag |

## Hidden Messages

The `hidden` flag is the same field that the built-in chat UI's "exclude from context" toggle controls. It lives on `message.extra.hidden` and is mirrored on every chat message event (`MESSAGE_SENT` / `MESSAGE_EDITED` / `MESSAGE_SWIPED`) inside the message's `extra` bag.

**What hiding currently does:**

- ✅ **Excludes the message from chat-memory embeddings.** Hidden messages are filtered out before chunking and never contribute to vector retrieval results.
- ❌ **Does NOT currently exclude the message from prompt-assembly chat history.** A hidden message is still visible to the LLM during normal generation. This asymmetry is intentional in the current build — hiding a message hides it from *retrieval* search but leaves the linear chat history alone.

If you need a guarantee that the LLM never sees a message, use `deleteMessage` or rewrite its `content` via `updateMessage`. Toggling `hidden` is the right tool for retrieval-side curation (e.g. an extension that flags noisy or off-topic messages so they stop polluting recall) but not for hard removal from prompts.

The bulk variant cap of 500 IDs per call mirrors the underlying service limit and exists to keep the SQLite transaction bounded.

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
