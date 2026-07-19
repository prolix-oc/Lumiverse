# Chat Mutation

!!! warning "Permission required: `chat_mutation`"

Read and modify chat messages directly. Use this for extensions that need to inject context, annotate messages, or manage conversation flow programmatically.

## Usage

```ts
// Read all messages in a chat
const messages = await spindle.chat.getMessages(chatId)
// [{ id, role, content, extra, metadata, swipe_id, swipes, swipe_dates }, ...]

// Append a new message
const { id } = await spindle.chat.appendMessage(chatId, {
  role: 'system',
  content: '[Extension note] Scene context updated.',
  metadata: { source: 'my_extension' },
})

// Append a user message and trigger a normal chat generation
const { id: messageId, generationId } = await spindle.chat.appendMessage(
  chatId,
  {
    role: 'user',
    content: 'What happens next?',
    metadata: { source: 'my_extension' },
  },
  true,
)

// Append and generate with explicit generation options
await spindle.chat.appendMessage(chatId, { role: 'user', content: 'Your turn.' }, {
  triggerGeneration: true,
  generation: {
    connection_id: 'connection-id',
    persona_id: 'persona-id',
    preset_id: 'preset-id',
    target_character_id: 'character-id',
  },
})

// Update an existing message's content (mirrors into swipes[swipe_id])
await spindle.chat.updateMessage(chatId, messageId, {
  content: 'Updated content here.',
  metadata: { edited_by: 'my_extension' },
})

// Rewrite the entire swipe array (dates auto-pad with `now` for new slots)
await spindle.chat.updateMessage(chatId, messageId, {
  swipes: ['first variant', 'second variant', 'third variant'],
  swipe_id: 2,
})

// Navigate to a different swipe without rewriting content
await spindle.chat.updateMessage(chatId, messageId, { swipe_id: 1 })

// Set or clear reasoning / reasoning_duration independently
await spindle.chat.updateMessage(chatId, messageId, {
  reasoning: { text: 'Chain-of-thought transcript…', duration: 1842 },
})
await spindle.chat.updateMessage(chatId, messageId, {
  reasoning: { text: null, duration: null }, // clear both
})

// Advanced: persist a maintenance rewrite without rebuilding chat chunks
await spindle.chat.updateMessage(chatId, messageId, {
  content: '<tracker type="sim">...</tracker>',
  skipChunkRebuild: true,
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
| `appendMessage(chatId, message, options?)` | `Promise<{ id: string; generationId?: string }>` | Add a new message. Fields: `{ role, content, metadata? }`. Pass `true` or `{ triggerGeneration: true }` as `options` to start a normal reply. |
| `updateMessage(chatId, messageId, patch)` | `Promise<void>` | Edit a message. See [Update Patch Shape](#update-patch-shape). |
| `deleteMessage(chatId, messageId)` | `Promise<void>` | Remove a message |
| `setMessageHidden(chatId, messageId, hidden)` | `Promise<void>` | Toggle the `hidden` flag on one message |
| `setMessagesHidden(chatId, messageIds, hidden)` | `Promise<void>` | Bulk variant. Up to 500 IDs per call. |
| `isMessageHidden(chatId, messageId)` | `Promise<boolean>` | Read the current hidden flag |
| `setStyleMode(chatId, mode, userId?)` | `Promise<void>` | Per-chat CSS containment mode. Requires `app_manipulation`, see [Per-Chat Style Mode](#per-chat-style-mode). |

## Append And Generate

`appendMessage()` can start the same normal chat-generation pipeline used by the built-in chat input. This is useful when an extension wants to programmatically send a user turn and let Lumiverse stream the assistant response into the chat.

```ts
const result = await spindle.chat.appendMessage(
  chatId,
  { role: 'user', content: 'Continue the scene.' },
  { triggerGeneration: true },
)

console.log(result.id)           // created user message id
console.log(result.generationId) // generation id for the streamed reply
```

Generation options mirror the normal `/generate` request fields that are safe for this path:

```ts
type AppendGenerationOptions = {
  connection_id?: string
  persona_id?: string
  persona_addon_states?: Record<string, boolean>
  preset_id?: string
  force_preset_id?: boolean
  parameters?: Record<string, unknown>
  target_character_id?: string
  retain_council?: boolean
}
```

!!! warning "Additional permission required: `generation`"
    Appending a message only requires `chat_mutation`. Starting generation from `appendMessage()` also requires the `generation` permission. If generation cannot start, the call fails before writing the message.

The generated assistant reply is delivered through the normal generation event stream (`GENERATION_STARTED`, token events, and `GENERATION_ENDED`). Use [`spindle.generate.observe(chatId)`](generation.md#spindlegenerateobservechatid) if your extension needs to watch the result.

## Update Patch Shape

```ts
type UpdateMessagePatch = {
  content?: string
  metadata?: Record<string, unknown>
  swipes?: string[]
  swipe_id?: number
  swipe_dates?: number[]
  reasoning?: {
    text?: string | null       // null clears extra.reasoning
    duration?: number | null   // null clears extra.reasoningDuration
  }
  skipChunkRebuild?: boolean
}
```

All fields are optional; `undefined` leaves the field untouched. Precedence rules:

- **`content` wins.** If you supply `content`, it overwrites both `message.content` and `swipes[swipe_id]` (the active slot).
- **Swipes without content.** Supply `swipes` alone and the new active content is derived from `swipes[swipe_id]` (either the supplied `swipe_id` or the existing one if you didn't patch it).
- **Navigation-only.** Supply `swipe_id` alone to cycle the active slot; content is re-derived from the existing `swipes` array.
- **`swipe_dates` auto-align.** If you rewrite `swipes` without supplying `swipe_dates`, the host pads new slots with the current timestamp and truncates trailing dates if the array shrank. If you want precise control, supply both.
- **Reasoning is independent.** `reasoning.text` and `reasoning.duration` are cleared independently with `null` — they are not forced to move together.
- **Chunk rebuilds are default behavior.** When the active message content changes, the host invalidates chat-memory cache and rebuilds `chat_chunks` so retrieval stays aligned with canonical stored content.
- **`skipChunkRebuild` is an advanced escape hatch.** Set `skipChunkRebuild: true` only for extension/host maintenance rewrites where you intentionally do not want that content edit to churn chat chunks.

### Validation

The host throws a per-request error (surfaced to the caller) if:

- `swipes` is empty after the patch is applied
- `swipe_id` is out of range (`< 0` or `>= swipes.length`, or non-finite)
- `swipes.length !== swipe_dates.length` after the patch and auto-align

These throw rather than silently clamp — partial writes would drift `swipes` / `swipe_dates` / `swipe_id` out of sync, and recovery is easier when the call fails loudly.

### Events emitted

- **Always:** `MESSAGE_EDITED { chatId, message }`.
- **Additionally:** `SWIPE_EDITED { chatId, message, previousSwipeId }` when any of `swipes` / `swipe_id` / `swipe_dates` was explicitly supplied. Plain content-only edits that mirror into the active slot do **not** emit `SWIPE_EDITED`.

`SWIPE_EDITED` is intentionally coarser than `MESSAGE_SWIPED` — the latter fires from the dedicated REST swipe routes (`addSwipe`, `updateSwipe`, `deleteSwipe`, `cycleSwipe`) with an `action` discriminator. Subscribe to `SWIPE_EDITED` when you need to react to extension-driven rewrites of the swipe array itself; subscribe to `MESSAGE_SWIPED` when you need `added` / `updated` / `deleted` / `navigated` semantics.

### Reasoning patch

`reasoning` targets the host-owned `extra.reasoning` (text) and `extra.reasoningDuration` (ms) fields projected for the active swipe. Supplying `reasoning: { text: "..." }` overwrites the active swipe's text without touching the duration; supplying `reasoning: { duration: null }` clears the active swipe's duration without touching the text.

A reasoning patch with no `metadata` patch still persists — the host writes the mutated `extra` bag whenever either `metadata` or `reasoning` touched it.

### Chat-chunk side effects

By default, `spindle.chat.updateMessage()` keeps retrieval data in sync with canonical chat content:

- If the active message content changes, the host invalidates chat-memory caches.
- It then rebuilds the chat's stored `chat_chunks` from canonical messages.
- Hidden messages remain excluded from chunk generation as usual.

`skipChunkRebuild: true` suppresses that rebuild path for the current update only. This is intended for advanced maintenance scenarios such as extension-owned normalization, metadata-preserving rewrites, or legacy-format repair where the canonical stored message must change but retrieval should remain untouched.

Use it sparingly. If you suppress rebuilds for semantic content edits, retrieval and memory-cortex data can drift away from the stored transcript until some later operation rebuilds the chat.

## Hidden Messages

!!! tip
    `spindle.chat.getMessages(chatId)` returns normalized `{ role, content }` fields, so you can pass its result directly to [`spindle.tokens.countMessages()`](tokens.md#spindletokenscountmessagesmessages-options) when you want a server-side token count for the current chat transcript.

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
  /**
   * The raw `extra` bag minus `spindle_metadata` (which is surfaced separately
   * on `metadata`). Carries reasoning text/duration, attachments, hidden flag,
   * and any host-owned housekeeping fields.
   */
  extra: Record<string, unknown>
  metadata?: Record<string, unknown>
  /** Active swipe index. `0` for messages with no alternates. */
  swipe_id: number
  /** All swipe variants for this message. `swipes[swipe_id]` equals `content`. */
  swipes: string[]
  /** Per-swipe creation timestamps (unix epoch seconds), aligned with `swipes`. */
  swipe_dates: number[]
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

## Per-Chat Style Mode

!!! warning "Permission required: `app_manipulation`"

Opt a chat out of the host's CSS containment sandbox so card-authored `position: fixed` content paints at viewport scope instead of resolving against the message bubble's containing block.

```ts
await spindle.chat.setStyleMode(chatId, 'extension-relaxed', userId)
// later, to revert:
await spindle.chat.setStyleMode(chatId, 'bounded', userId)
```

| Mode | Behavior |
|------|----------|
| `'bounded'` (default) | Virtualized rows carry `transform: translateY(...)`, bubbles carry `contain: layout style paint`. `position: fixed` descendants are trapped at bubble coordinates per CSS spec. |
| `'extension-relaxed'` | Rows switch to `top: Npx`, bubbles drop to `contain: style`, streaming `will-change` drops `transform`. `position: fixed` descendants escape to the viewport. |

State is held per-chat in the frontend store, not persisted to the database. The extension re-sets on each chat-open (or `SETTINGS_UPDATED activeChatId`) for chats it wants relaxed. When the extension is disabled, uninstalled, or its worker stops, all of its claims are dropped automatically.

Multiple extensions can claim the same chat. A chat is effectively `'extension-relaxed'` if at least one claimant has set that mode. The `'bounded'` call removes that extension's claim without affecting others.

Frontend reflects the change via the `SPINDLE_CHAT_STYLE_MODE` WS event (see [Events](events.md)).

### Trade-offs

Relaxed-mode rows position via `top` instead of `transform`, so each row-position update triggers a layout pass rather than a compositor-only update. For typical chat-list sizes this is imperceptible. For fast flick-scroll on very long chats it may be measurable. Use this mode only for chats whose content genuinely needs viewport-scope rendering.
