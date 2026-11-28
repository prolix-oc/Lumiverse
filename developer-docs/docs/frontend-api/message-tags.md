# Message Tag Interceptors

Extensions can intercept custom XML-like tags embedded in chat messages. This lets you build inline interactive elements — for example, a `<spotify-search query="...">` tag that triggers a search when rendered.

## Declare the backend capability

If the extension has a backend entry, declare its use of message-tag
interception during backend startup:

```ts
const releaseTagCapability = spindle.frontendCapabilities.declare(
  'message_tag_interceptor'
)
```

The host includes this runtime declaration in frontend bootstrap state. Chat
content then remains in its initial hidden state until the extension frontend
attaches at least one tag interceptor (or the bounded host fallback expires),
preventing raw tag payloads from flashing during cold chat load. The returned
function retracts the declaration; worker shutdown also clears it
automatically.

This declaration does not define a tag or replace the frontend registration.
The frontend remains authoritative for `tagName`, `attrs`,
`removeFromMessage`, and the handler, so those options can still come from
per-user settings.

## `ctx.messages.registerTagInterceptor(options, handler)`

Register a handler that fires whenever a matching tag appears in a rendered message. Returns an unsubscribe function.

```ts
const unsub = ctx.messages.registerTagInterceptor(
  { tagName: 'my-action' },
  (payload) => {
    console.log('Tag found:', payload.tagName, payload.attrs, payload.content)
    console.log('In message:', payload.messageId, 'chat:', payload.chatId)
  }
)

// Unsubscribe later
unsub()
```

## SpindleMessageTagInterceptorOptions

| Field | Type | Description |
|---|---|---|
| `tagName` | `string` | The tag name to match (e.g. `'my-action'` matches `<my-action>`) |
| `attrs` | `Record<string, string>` | Optional. Only match tags that have these exact attribute values |
| `removeFromMessage` | `boolean` | Optional. If `true`, the matched tag is stripped from the rendered message output. During streaming, content is hidden as soon as the matching opening tag appears and replaced with a subtle inline "extension is processing" indicator. Normal rendering resumes after the closing tag arrives. |
| `displaySlot` | `(payload) => { key: string; aspectRatio: number } \| null \| undefined` | Optional runtime capability described below. Reserves an ephemeral display anchor in place of a removed, complete tag. |

## Display slots (`message-tag-display-slot-v1`)

Feature-detect `ctx.host.capabilities['message-tag-display-slot-v1'] >= 1`
before using `displaySlot`. Existing interceptors keep their existing behavior.
This is an additive frontend capability; it does not change stored messages,
generation requests, permissions, or handler delivery and deduplication.

The callback receives the normal interception payload, including your extension
installation ID, plus `displaySwipeIndex` for the displayed alternative. It runs
synchronously during rendering and can run repeatedly. Keep it pure: return a
stable key and aspect ratio, and perform work through the existing handler.
Returning `null` or `undefined`, throwing, or returning invalid values leaves
the tag stripped without a slot. Keys must contain 1–180 ASCII letters, digits,
colons, underscores, or hyphens. Aspect ratios must be finite numbers from 0.1
through 10.

Slots require an assistant message with chat and message IDs and a nonnegative
integer swipe index. They are not created for user messages, read-only previews,
incomplete streaming tags, or `removeFromMessage: false`. Incomplete streaming
tags retain the existing pending indicator.

The published `lumiverse-spindle-types` 0.6.81 options do not yet declare this
runtime addition. A structurally typed options variable works with that version:

```ts
import type { SpindleMessageTagIntercept } from 'lumiverse-spindle-types'

if ((ctx.host.capabilities['message-tag-display-slot-v1'] ?? 0) >= 1) {
  const options = {
    tagName: 'illustration',
    displaySlot: (
      payload: SpindleMessageTagIntercept & { displaySwipeIndex?: number }
    ) => payload.attrs.id
      ? { key: payload.attrs.id, aspectRatio: 4 / 3 }
      : null,
  }
  const unsubscribe = ctx.messages.registerTagInterceptor(options, payload => {
    // Receive the packet as before; update extension-owned preview state here.
  })
  // Call unsubscribe during extension cleanup.
}
```

An anchor exposes these attributes for extension discovery:

| Attribute | Value |
|---|---|
| `data-spindle-tag-display` | Extension installation ID |
| `data-spindle-tag-display-key` | Callback's key |
| `data-spindle-tag-chat` | Chat ID |
| `data-spindle-tag-message` | Message ID |
| `data-spindle-tag-swipe` | Displayed swipe index |
| `data-spindle-tag-streaming` | `"true"` or `"false"` |

Scope discovery by all identity attributes. Use unique keys for independent
slots within a message and swipe. Attribute values are escaped; packet contents
are not embedded in the anchor. The anchor reserves the full available width
with the requested aspect ratio.

Mount ephemeral UI inside an open shadow root on the anchor. The host preserves
that root across prose updates while reconciling the anchor's attributes;
children placed directly in its light DOM can be removed on the next update.
Do not depend on the anchor's tag name or modify its identity attributes.

The handler can run before its anchor mounts, and deduplicated handlers do not
run again just because a virtualized message remounts. Observe anchor mounting
separately, restore UI from extension-owned state, and release observers,
listeners, React roots, and object URLs during cleanup. A different chat,
message, or swipe gets a different anchor; unmounting or unregistering removes
the old display. Read `data-spindle-tag-streaming` to observe completion rather
than treating a new handler delivery as a new slot.

## SpindleMessageTagIntercept (handler payload)

| Field | Type | Description |
|---|---|---|
| `extensionId` | `string` | Your extension's ID |
| `tagName` | `string` | The matched tag name |
| `attrs` | `Record<string, string>` | All attributes on the tag |
| `content` | `string` | Inner text content of the tag |
| `fullMatch` | `string` | The full matched tag string |
| `messageId` | `string?` | ID of the message containing the tag |
| `chatId` | `string?` | ID of the chat containing the message |
| `isUser` | `boolean?` | Whether the message is from the user |
| `isStreaming` | `boolean?` | Whether the message is still streaming |

## Example: Inline Search Tag

```ts
// Intercept <spotify-search query="..."> tags in messages
const unsub = ctx.messages.registerTagInterceptor(
  { tagName: 'spotify-search' },
  (payload) => {
    const query = payload.attrs.query
    if (query) {
      ctx.sendToBackend({ type: 'search', query })
    }
  }
)
```

When an LLM or user includes `<spotify-search query="chill vibes">` in a message, the handler fires and can trigger extension logic.
