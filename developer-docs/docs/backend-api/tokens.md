# Tokens

Request token counts from the Lumiverse server using the same tokenizer-resolution logic the backend uses for prompt assembly and generation breakdowns.

No permission is required. This is a free-tier API.

## Usage

```ts
// Count plain text against an explicit model id
const textCount = await spindle.tokens.countText('Hello from my extension', {
  model: 'gpt-4o-mini',
})

// Count a message array against the selected sidecar model
const messages = await spindle.chat.getMessages(chatId)
const messageCount = await spindle.tokens.countMessages(messages, {
  modelSource: 'sidecar',
})

// Count the live stored chat directly on the server
const chatCount = await spindle.tokens.countChat(chatId)

spindle.log.info(
  `Chat uses ${chatCount.total_tokens} tokens on ${chatCount.model} (${chatCount.tokenizer_name})`
)
```

## Model Resolution

All three methods accept two optional knobs:

- `options.model` — explicit model ID override
- `options.modelSource` — resolve from the user's configured main or sidecar selection

Resolution precedence is:

1. `options.model`
2. `options.modelSource`
3. default to `'main'`

### `modelSource`

All three methods accept an optional `options.modelSource`:

- `'main'` — use the user's default main connection profile model
- `'sidecar'` — use the user's selected sidecar model, or fall back to that sidecar connection's configured model when the sidecar model override is empty

If omitted, `modelSource` defaults to `'main'`.

### Explicit `model`

If your extension already knows which model it wants to count against, pass it directly:

```ts
const conn = await spindle.connections.get(connectionId)
if (!conn) throw new Error('Connection not found')

const result = await spindle.tokens.countMessages(messages, {
  model: conn.model,
})
```

When `model` is supplied, the result reports `modelSource: 'explicit'`.

## Methods

### `spindle.tokens.countText(text, options?)`

Count tokens for a raw string.

```ts
const result = await spindle.tokens.countText('Summarize this paragraph', {
  modelSource: 'main',
})
```

**Returns:** `Promise<TokenCountResultDTO>`

### `spindle.tokens.countMessages(messages, options?)`

Count tokens for an array of `{ role, content }` messages.

This accepts the normalized output of `spindle.chat.getMessages(chatId)` directly because those message objects already expose compatible `role` and `content` fields.

```ts
const messages = await spindle.chat.getMessages(chatId)

const result = await spindle.tokens.countMessages(messages, {
  modelSource: 'sidecar',
})
```

**Returns:** `Promise<TokenCountResultDTO>`

### `spindle.tokens.countChat(chatId, options?)`

Count tokens for the current stored contents of a Lumiverse chat.

The host reads the chat messages from the database, normalizes their roles the same way `spindle.chat.getMessages()` does, flattens them into the token-count wire format, and then runs the resolved tokenizer.

```ts
const result = await spindle.tokens.countChat(chatId, {
  modelSource: 'main',
})
```

**Returns:** `Promise<TokenCountResultDTO>`

## Result Shape

```ts
type TokenCountResultDTO = {
  total_tokens: number
  model: string
  modelSource: 'main' | 'sidecar' | 'explicit'
  tokenizer_id: string | null
  tokenizer_name: string
  approximate: boolean
}
```

| Field | Type | Description |
|---|---|---|
| `total_tokens` | `number` | Computed token count for the supplied text or messages |
| `model` | `string` | Model ID that was actually used to resolve the tokenizer |
| `modelSource` | `'main' \| 'sidecar' \| 'explicit'` | Which configuration source supplied the model |
| `tokenizer_id` | `string \| null` | Matched tokenizer ID, or `null` when no exact tokenizer mapping was found |
| `tokenizer_name` | `string` | Human-readable tokenizer label |
| `approximate` | `boolean` | `true` when Lumiverse fell back to the approximate char/4 heuristic |

## Error Cases

These helpers reject when the server cannot resolve the requested model context. Common examples:

- no default connection is configured and `modelSource` is `'main'`
- the default connection exists but does not have a model configured
- no sidecar connection is configured and `modelSource` is `'sidecar'`
- the selected sidecar connection no longer exists
- `model` is supplied but is an empty string
- `countChat(chatId)` is called for a chat the extension cannot access

## Notes

- The count reflects Lumiverse's tokenizer mapping for the resolved model, not the upstream provider's eventual billing counters.
- When no tokenizer pattern matches the resolved model, Lumiverse falls back to an approximate `chars / 4` heuristic and sets `approximate: true`.
- `countMessages()` flattens messages as `role + newline + content`, matching the backend's shared token-count helper for chat-style message arrays.

!!! note
    For user-scoped extensions, the user context is inferred automatically. For operator-scoped extensions, pass `options.userId` when counting text or message arrays. `countChat(chatId)` derives ownership from the chat itself and rejects if you provide a mismatched `userId`. Passing an explicit `model` does not require connection access permissions because token counting only uses Lumiverse's tokenizer mapping, not API keys or live provider calls.

## Tokenizer loading and prompt assembly

The application warms the selected connection's tokenizer after selection or a model edit, in the runtime that will assemble the next prompt. Assembly also starts loading as soon as it resolves its connection. Generation joins any pending load. Workers prefer an idle runtime that already holds the requested tokenizer, retaining chat affinity when possible.

Authenticated clients can request this preparation with `POST /api/v1/tokenizers/warm`, passing `{ "connection_id": "...", "chat_id": "..." }`. The optional chat ID is a worker-routing hint. The connection must belong to the caller; omitting the connection ID uses their default. A `202` response with `{ "queued": true }` acknowledges best-effort scheduling, not completion. Tokenizer administration still requires owner/admin access.

Downloaded tokenizer files live in `DATA_DIR/cache/tokenizers-v1`. The cache survives restarts and worker eviction, expires resources after seven days, and prunes old entries toward a 512 MiB budget during downloads. Individual resources are limited to 128 MiB. Cache keys include source URLs, tokenizer configuration, and hashed authentication identity; startup timestamps do not invalidate them. Changing source/configuration selects a new cache key. Writes are atomic, concurrent runtimes coordinate downloads, and worker termination releases that worker's file leases. An unavailable disk cache falls back to downloading.

Independent model/config downloads run concurrently, with a 30-second deadline covering body consumption. Failed instance loads have a 15-second retry cooldown. Config edits invalidate main/worker state, and asynchronous loads cannot reinstall an obsolete encoding. Counts include configuration and artifact revisions in their cache identity. Single-text and batch requests can reuse memoized counts after instance eviction without rebuilding the tokenizer.

Each runtime retains up to five tokenizer instances. Assembly workers expire after ten idle minutes by default; set `LUMIVERSE_PROMPT_ASSEMBLY_IDLE_MS` to a value between 30,000 and 1,800,000 to adjust this. Memory-pressure notifications can release idle workers sooner. Extension macros/interceptors that require the main process continue using the main-process tokenizer cache.

Slow-operation logs distinguish the work previously grouped under `context-clip`:

- `tokenizer-load`: module import, disk/network resources, parsing, construction, runtime, and failure state.
- `context-clip`: `tokenizer-wait`, `count-and-clip`, encoding time, instance-cache status, and content-cache hit/miss counts. Encoding time is a component of `count-and-clip`; do not add the overlapping phases together.

The existing `LUMIVERSE_PROMPT_PHASE_WARN_MS` and `LUMIVERSE_PROMPT_TOTAL_WARN_MS` thresholds apply. Logs do not include prompt text. Kimi/tiktoken counting uses a count-only BPE implementation with the configured vocabulary, split pattern, and special-token policy; OpenAI encodings use `gpt-tokenizer`'s count-only API.
