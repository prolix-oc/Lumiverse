# Message Content Processor

!!! warning "Permission required: `chat_mutation`"

Message content processors run before a user-initiated message write reaches the database. They can transform `content` and `extra` so the stored row and every WebSocket subscriber see the transformed version on first paint.

```ts
spindle.registerMessageContentProcessor(async (ctx) => {
  if (!ctx.content.includes('{{my_macro}}')) return

  return {
    content: ctx.content.replaceAll('{{my_macro}}', 'resolved value'),
  }
}, 50) // priority: lower runs first (default: 100)
```

Use this when the transform belongs on the stored message itself, not just on the in-flight LLM call.

## Parameters

| Param | Type | Description |
| --- | --- | --- |
| `handler`  | `(ctx: MessageContentProcessorCtx) => Promise<MessageContentProcessorResult \| void>` | Receives the about-to-be-committed content; returns a patch, or `void` to pass through |
| `priority` | `number` | Optional. Lower values run first. Default:`100` |

## Context Object

```ts
interface MessageContentProcessorCtx {
  chatId: string
  messageId?: string                              // undefined for "create"
  content: string
  extra?: Record<string, unknown>                 // populated with { role, is_user } for "render"
  origin: "create" | "update" | "swipe_add" | "swipe_update" | "render"
  swipeIndex?: number                             // set for "swipe_update"
  userId: string                                  // pass to operator-scoped Spindle calls
}
```

### Origin values

| Origin | Route | Notes |
| --- | --- | --- |
| `"create"` | `POST /api/v1/chats/:chatId/messages` | New message row. |
| `"create"` | `POST /chats`, `POST /group`, `POST /:id/members/:characterId` | Auto-inserted greeting. The chain fires after insert; a follow-up update is written if the handler modifies content or extra. |
| `"update"` | `PUT /api/v1/chats/:chatId/messages/:id` | Edits an existing message's content or extra. |
| `"swipe_add"` | `POST /api/v1/chats/:chatId/messages/:id/swipe` (with `content`) | Appends a new swipe. |
| `"swipe_update"` | `PUT /api/v1/chats/:chatId/messages/:id/swipe/:idx` | Rewrites the swipe at `swipeIndex`. |
| `"render"` | `POST /api/v1/chats/:chatId/display-preprocess` | Per-render transform for display only. Output feeds the display-regex pass and final paint. Does not write to the message row. |

Returned `extra` is ignored on swipe origins: swipes share the parent message's `extra`, which `addSwipe` and `updateSwipe` cannot patch. Only `content` is honored.

Returned `extra` is also ignored on `render`. There is no row to mutate, so only `content` is honored.

Cycling through existing swipes (`{direction: "left"|"right"}`) does not fire the hook; no content changes.

### Render origin

`render` is a non-persisting origin. The frontend calls `POST /api/v1/chats/:chatId/display-preprocess` once per visible message, the chain runs in the same priority order as write-time origins, and the returned content feeds into the display-regex pass before the host's `richHtmlSanitizer` paints it.

The transformed content is visible only on the rendered message. It is invisible to:

- `spindle.chat.getMessages()` and any other read of the stored row
- write-time origins (`create`, `update`, `swipe_add`, `swipe_update`)
- chat memory embeddings, prompt assembly, and exports

Use `render` for per-render rewrites that depend on transient or per-message context (chat-var values, the message's own position, etc.) and would pollute history if persisted. Use a write-time origin when the transform belongs on the stored message itself.

The render context populates `extra` with hints from the calling frontend:

| Field | Type | Description |
| --- | --- | --- |
| `extra.role`| `string` | `"user"`, `"assistant"`, or `"system"`. |
| `extra.is_user` | `boolean` | Mirror of `role === "user"`. |

`messageId` is set on the context when the rendered message has one. The route accepts an optional `messageIndex` body field that lands on `extra.messageIndex` if supplied by the caller.

## Return Value

```ts
interface MessageContentProcessorResult {
  content?: string
  extra?: Record<string, unknown>
}
```

Return `undefined` or `void` to pass through. Otherwise:

- `content`: if present, replaces the content for downstream processors and the database write.
- `extra`: if present, shallow-merges into the existing `extra` (omitted keys preserved, included keys overwrite).

## Composition Order

Multiple processors run in priority order (lower first, default `100`), with registration order as the tie-breaker. Each processor sees the previous one's returned patch.

## Timeout

Each processor runs inside a 10-second wall-clock budget. On timeout or thrown error: the chain logs the failure and forwards the previous content to the next handler. The write still proceeds.

!!! warning "Users notice the wait"
    The processor fires before the database write. Every millisecond of handler work is a millisecond of visible latency on send, edit, or swipe. Keep the hook tight.

## Message Content Processor vs Interceptor vs Context Handler

| Hook | When it fires | What it changes |
| --- | --- | --- |
| [Context Handler](context-handlers.md) | Before prompt assembly | The generation context |
| [Interceptor](interceptors.md) | After assembly, before LLM call | The outgoing message array |
| **Message Content Processor** | Before the message row is written to the database | The content and extra of a user-initiated message write |
