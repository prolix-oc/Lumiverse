# Generation

!!! warning "Permission required: `generation`"

Fire LLM generations programmatically.

## `spindle.generate.raw(input)`

Direct generation — you specify the provider, model, and messages.

```ts
const result = await spindle.generate.raw({
  messages: [
    { role: 'user', content: 'Summarize this text: ...' },
  ],
  parameters: { temperature: 0.3, max_tokens: 200 },
  connection_id: 'optional-connection-id',
})
// result: { content: string, finish_reason: string, usage: { ... } }
```

## `spindle.generate.quiet(input)`

Uses the user's active connection profile and preset parameters.

```ts
const result = await spindle.generate.quiet({
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello!' },
  ],
})
```

## `spindle.generate.batch(input)`

Run multiple generation requests.

```ts
const results = await spindle.generate.batch({
  requests: [
    { messages: [...], provider: 'openai', model: 'gpt-4o' },
    { messages: [...], provider: 'openai', model: 'gpt-4o' },
  ],
  concurrent: true,
})
// results: Array<{ index, success, content?, error? }>
```

## GenerationRequestDTO

| Field | Type | Description |
|---|---|---|
| `messages` | `LlmMessageDTO[]` | The message array to send |
| `parameters` | `Record<string, unknown>` | Optional LLM parameters (temperature, max_tokens, etc.) |
| `connection_id` | `string` | Optional. Use a specific connection profile (see Connection Profiles below) |
| `signal` | `AbortSignal` | Optional. Cancel the in-flight LLM request when the signal fires (see Cancellation below) |

---

## Cancellation

Every generation method (`raw`, `quiet`, `batch`, `rawStream`, `quietStream`) accepts an optional `AbortSignal`. When the signal fires, the upstream LLM HTTP request is torn down and the call rejects with a standard `DOMException` whose `.name === "AbortError"`.

The signal is consumed inside the extension worker and never crosses the wire. When abort fires, the worker posts an internal `cancel_generation` message to the host, which calls `controller.abort()` on the `AbortController` it created for the upstream provider call.

```ts
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 5_000)

try {
  const result = await spindle.generate.raw({
    messages: [{ role: 'user', content: 'Write a long essay…' }],
    signal: controller.signal,
  })
  // result: { content, finish_reason, usage }
} catch (err) {
  if (err.name === 'AbortError') {
    spindle.log.info('Generation cancelled')
  } else {
    throw err
  }
} finally {
  clearTimeout(timer)
}
```

Compose with `AbortSignal.timeout()` and `AbortSignal.any()` for richer cancellation semantics:

```ts
const userController = new AbortController()
const signal = AbortSignal.any([
  userController.signal,
  AbortSignal.timeout(30_000),
])

await spindle.generate.quiet({ messages, signal })
```

For `batch`, the same signal is threaded into every sub-request. Aborting mid-flight cancels the in-flight call and prevents any not-yet-started sequential calls from beginning. With `concurrent: true`, every parallel call sees the abort.

---

## Streaming

Stream tokens incrementally as the LLM emits them, instead of waiting for the full response. `rawStream` and `quietStream` mirror their non-streaming counterparts but return an `AsyncGenerator<StreamChunkDTO>` that you can iterate with `for await`.

The generator yields one or more `token` / `reasoning` chunks and exactly one terminal `done` chunk carrying the aggregated response. If the call fails or is aborted, the generator throws instead of yielding `done`.

### `spindle.generate.rawStream(input)`

```ts
let acc = ''
for await (const chunk of spindle.generate.rawStream({
  provider: 'openai',
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Tell me a story.' }],
})) {
  if (chunk.type === 'token') {
    acc += chunk.token
    process.stdout.write(chunk.token)
  } else if (chunk.type === 'reasoning') {
    spindle.log.info(`[thinking] ${chunk.token}`)
  } else if (chunk.type === 'done') {
    spindle.log.info(`Final usage: ${chunk.usage?.total_tokens} tokens`)
    spindle.log.info(`finish_reason: ${chunk.finish_reason}`)
  }
}
```

### `spindle.generate.quietStream(input)`

Same semantics as `rawStream`, but uses the user's active connection profile and preset parameters (no `provider`/`model` required).

```ts
for await (const chunk of spindle.generate.quietStream({
  messages: [{ role: 'user', content: 'Hello!' }],
})) {
  if (chunk.type === 'token') process.stdout.write(chunk.token)
}
```

### Cancelling a stream

`rawStream` / `quietStream` accept the same `AbortSignal` as the non-streaming methods. The generator throws `AbortError` on abort. You can also break out of the `for await` loop early — the generator's cleanup posts a cancel message to tear down the upstream request.

```ts
const controller = new AbortController()
setTimeout(() => controller.abort(), 2_000)

try {
  for await (const chunk of spindle.generate.rawStream({
    messages: [{ role: 'user', content: 'Long answer…' }],
    signal: controller.signal,
  })) {
    if (chunk.type === 'token') process.stdout.write(chunk.token)
  }
} catch (err) {
  if (err.name === 'AbortError') spindle.log.info('Stream cancelled')
  else throw err
}

// Or break early — same effect, no AbortController needed:
for await (const chunk of spindle.generate.quietStream({ messages })) {
  if (chunk.type === 'token' && shouldStop()) break // host receives cancel
}
```

### StreamChunkDTO

A discriminated union with three variants:

| `type` | Fields | Description |
|---|---|---|
| `"token"` | `token: string` | Incremental content token. |
| `"reasoning"` | `token: string` | Incremental chain-of-thought token (provider-dependent). |
| `"done"` | `content: string`, `reasoning?: string`, `finish_reason: string`, `tool_calls?: ToolCallDTO[]`, `usage?: { prompt_tokens, completion_tokens, total_tokens }` | Terminal chunk — emitted exactly once on success. Carries the aggregated response so you don't need to accumulate manually if you don't want to. |

!!! note "No `batchStream`"
    Batch is just a wrapper around N raw calls. If you want parallel streamed responses, run `Promise.all([rawStream(a), rawStream(b)])` and consume each iterator however you like.

---

## Dry Run (Prompt Assembly)

Run the full prompt assembly pipeline — macros, world info, context filters, memory retrieval, token counting — without actually calling the LLM. Useful for prompt debugging, token budget analysis, and previewing what the model will see.

### `spindle.generate.dryRun(input, userId?)`

```ts
const result = await spindle.generate.dryRun({
  chatId: 'chat-id',
}, userId) // userId required for operator-scoped extensions

spindle.log.info(`Provider: ${result.provider}, Model: ${result.model}`)
spindle.log.info(`Assembled ${result.messages.length} messages`)
spindle.log.info(`Breakdown: ${result.breakdown.length} blocks`)

if (result.tokenCount) {
  spindle.log.info(`Total tokens: ${result.tokenCount.total_tokens}`)
}

if (result.worldInfoStats) {
  spindle.log.info(`WI entries activated: ${result.worldInfoStats.activatedAfterBudget}`)
}

if (result.memoryStats?.enabled) {
  spindle.log.info(`Memory chunks retrieved: ${result.memoryStats.chunksRetrieved}`)
}
```

You can optionally override the connection, persona, preset, or generation type:

```ts
const result = await spindle.generate.dryRun({
  chatId: 'chat-id',
  connectionId: 'specific-connection',   // default: user's default connection
  personaId: 'specific-persona',         // default: user's active/default persona
  presetId: 'specific-preset',           // default: connection's linked preset
  generationType: 'continue',            // default: 'normal'
  parameters: { temperature: 0.8 },      // override sampler params
}, userId)
```

### DryRunRequestDTO

| Field | Type | Description |
|---|---|---|
| `chatId` | `string` | **Required.** The chat to assemble the prompt for. |
| `connectionId` | `string` | Optional. Use a specific connection profile. |
| `personaId` | `string` | Optional. Use a specific persona. |
| `presetId` | `string` | Optional. Use a specific preset. |
| `generationType` | `string` | Optional. One of `"normal"`, `"continue"`, `"regenerate"`, `"swipe"`, `"impersonate"`. |
| `parameters` | `Record<string, unknown>` | Optional. Override sampler parameters. |

`dryRun` also accepts a second argument:

| Argument | Type | Description |
|---|---|---|
| `userId` | `string` | **Required for operator-scoped extensions.** The user ID to scope the dry run to. For user-scoped extensions, this is inferred automatically and can be omitted. |

### DryRunResultDTO

| Field | Type | Description |
|---|---|---|
| `messages` | `LlmMessageDTO[]` | The fully assembled message array that would be sent to the LLM. |
| `breakdown` | `AssemblyBreakdownEntryDTO[]` | Ordered list of prompt blocks showing how the prompt was built. |
| `parameters` | `Record<string, unknown>` | Final merged sampler parameters. |
| `model` | `string` | The model that would be used. |
| `provider` | `string` | The provider that would be used. |
| `tokenCount` | `DryRunTokenCountDTO` | Optional. Per-block token counts (if a tokenizer is available). |
| `worldInfoStats` | `ActivationStatsDTO` | Optional. World info activation statistics. |
| `memoryStats` | `MemoryStatsDTO` | Optional. Long-term memory retrieval statistics. |

### AssemblyBreakdownEntryDTO

Each entry represents one block in the assembled prompt:

| Field | Type | Description |
|---|---|---|
| `type` | `string` | Block type: `"block"`, `"chat_history"`, `"world_info"`, `"authors_note"`, `"utility"`, `"long_term_memory"`, `"separator"`, `"append"`, `"sidecar"`. |
| `name` | `string` | Human-readable block name. |
| `role` | `string` | Message role (`"system"`, `"user"`, `"assistant"`). |
| `content` | `string` | The resolved text content. |
| `blockId` | `string` | Preset block ID (if from a preset block). |

### ActivationStatsDTO

| Field | Type | Description |
|---|---|---|
| `totalCandidates` | `number` | Total WI entries considered. |
| `activatedBeforeBudget` | `number` | Entries that matched before budget enforcement. |
| `activatedAfterBudget` | `number` | Entries included after budget enforcement. |
| `evictedByBudget` | `number` | Entries dropped due to budget limits. |
| `evictedByMinPriority` | `number` | Entries dropped due to minimum priority threshold. |
| `estimatedTokens` | `number` | Approximate total WI tokens (chars/4). |
| `recursionPassesUsed` | `number` | Number of keyword-chaining recursion passes. |

### MemoryStatsDTO

| Field | Type | Description |
|---|---|---|
| `enabled` | `boolean` | Whether long-term memory is active. |
| `chunksRetrieved` | `number` | Number of memory chunks included. |
| `chunksAvailable` | `number` | Total chunks in the vector store. |
| `chunksPending` | `number` | Chunks awaiting vectorization. |
| `injectionMethod` | `string` | How memories were injected: `"macro"`, `"fallback"`, or `"disabled"`. |
| `queryPreview` | `string` | Truncated query text used for vector search. |
| `settingsSource` | `string` | Whether settings came from `"global"` or `"per_chat"` overrides. |

!!! tip
    Dry run mirrors the exact assembly pipeline used during real generation (macros, world info, context filters, memory) but skips the council execution and LLM call. It's the fastest way to debug prompt construction.

---

## Structured Output

Some providers support native structured output, ensuring the LLM response conforms to a JSON schema. Pass provider-specific parameters via the `parameters` field.

### Google Gemini

Use `responseMimeType` and `responseSchema` to request structured JSON output:

```ts
const result = await spindle.generate.raw({
  messages: [
    { role: 'user', content: 'Extract the character name and age from: "Alice is 25 years old."' },
  ],
  parameters: {
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
      },
      required: ['name', 'age'],
    },
  },
  connection_id: 'my-gemini-connection',
})
// result.content: '{"name": "Alice", "age": 25}'
```

`responseJsonSchema` is accepted as an alias for `responseSchema`.

### OpenAI-compatible

Use the standard `response_format` parameter:

```ts
const result = await spindle.generate.raw({
  messages: [
    { role: 'user', content: 'Extract the character name and age.' },
  ],
  parameters: {
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'character_info',
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'integer' },
          },
          required: ['name', 'age'],
        },
      },
    },
  },
  connection_id: 'my-openai-connection',
})
```

### Anthropic

Anthropic uses tool definitions for structured output. Define a tool with the desired output schema and set `tool_choice` to force it:

```ts
const result = await spindle.generate.raw({
  messages: [
    { role: 'user', content: 'Extract the character name and age.' },
  ],
  parameters: {
    tools: [{
      name: 'extract_info',
      description: 'Extract structured character information',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' },
        },
        required: ['name', 'age'],
      },
    }],
    tool_choice: { type: 'tool', name: 'extract_info' },
  },
  connection_id: 'my-anthropic-connection',
})
```

!!! tip
    Provider-specific parameters are passed through to the underlying API. Any parameter not explicitly handled by Lumiverse is forwarded directly, so you can use provider-specific features even if they aren't documented here.

---

## Stream Observation

Observe an in-flight LLM generation in real time. `observe()` subscribes to all generation lifecycle events for a specific chat, accumulates streamed content and reasoning tokens automatically, and exposes them through a simple callback API.

### `spindle.generate.observe(chatId)`

Returns a `GenerationObserver` that filters events to the given chat.

```ts
const observer = spindle.generate.observe('chat-uuid')

observer.onStart((info) => {
  spindle.log.info(`Generation started: ${info.model}`)
})

observer.onToken((token) => {
  // Called for every streamed token (content and reasoning)
  if (token.type === 'reasoning') {
    spindle.log.info(`[thinking] ${token.token}`)
  }
})

observer.onEnd((result) => {
  if (result.error) {
    spindle.log.error(`Generation failed: ${result.error}`)
  } else {
    spindle.log.info(`Done — ${observer.content.length} chars`)
  }
  observer.dispose()
})

observer.onStop((result) => {
  spindle.log.info(`Stopped early — partial: ${observer.content.length} chars`)
  observer.dispose()
})
```

At any point during streaming you can read the accumulated state:

```ts
observer.content    // all content tokens concatenated
observer.reasoning  // all reasoning tokens concatenated
observer.generationId  // active generation ID, or null if idle
```

!!! warning "Always call `dispose()`"
    The observer subscribes to four event channels internally. Call `observer.dispose()` when you no longer need it to unsubscribe and free resources.

### GenerationObserver

| Property / Method | Type | Description |
|---|---|---|
| `onStart(handler)` | `(info: GenerationStartedPayloadDTO) => void` | Called when a generation begins on this chat |
| `onToken(handler)` | `(token: StreamTokenPayloadDTO) => void` | Called for each streamed token |
| `onEnd(handler)` | `(result: GenerationEndedPayloadDTO) => void` | Called when the generation completes or errors |
| `onStop(handler)` | `(result: GenerationStoppedPayloadDTO) => void` | Called when the user stops the generation |
| `content` | `string` (readonly) | Accumulated content tokens |
| `reasoning` | `string` (readonly) | Accumulated reasoning/CoT tokens |
| `generationId` | `string \| null` (readonly) | Active generation ID |
| `dispose()` | `() => void` | Unsubscribe from all events |

### GenerationStartedPayloadDTO

| Field | Type | Description |
|---|---|---|
| `generationId` | `string` | Unique generation ID |
| `chatId` | `string` | Chat this generation belongs to |
| `model` | `string` | Model being used |
| `targetMessageId` | `string` | Optional. ID of the message being generated/regenerated |
| `characterId` | `string` | Optional. Target character ID |
| `characterName` | `string` | Optional. Target character name |

### StreamTokenPayloadDTO

| Field | Type | Description |
|---|---|---|
| `generationId` | `string` | Generation this token belongs to |
| `chatId` | `string` | Chat ID |
| `token` | `string` | The text chunk |
| `seq` | `number` | Monotonic sequence number (for deduplication) |
| `type` | `"reasoning"` | Optional. Present for chain-of-thought tokens |

### GenerationEndedPayloadDTO

| Field | Type | Description |
|---|---|---|
| `generationId` | `string` | Generation ID |
| `chatId` | `string` | Chat ID |
| `messageId` | `string` | ID of the saved message (absent on error) |
| `content` | `string` | Final generated content (absent on error) |
| `error` | `string` | Error message (absent on success) |

### GenerationStoppedPayloadDTO

| Field | Type | Description |
|---|---|---|
| `generationId` | `string` | Generation ID |
| `chatId` | `string` | Chat ID |
| `content` | `string` | Partial content accumulated before the stop |

### Raw event subscription

If you need lower-level control (e.g. observing multiple chats, or only specific events), you can subscribe to the generation events directly. These are fully typed when using `lumiverse-spindle-types`:

```ts
const unsub = spindle.on('STREAM_TOKEN_RECEIVED', (payload) => {
  // payload is typed as StreamTokenPayloadDTO
  console.log(payload.token, payload.seq)
})

// Clean up when done
unsub()
```

Available generation events: `GENERATION_STARTED`, `STREAM_TOKEN_RECEIVED`, `GENERATION_ENDED`, `GENERATION_STOPPED`.

---

## Connection Profiles

Extensions with the `generation` permission can discover and inspect the user's connection profiles. This lets you present a UI for selecting which LLM provider/model to use, or programmatically pick the right connection for your use case.

Connection profiles are returned as safe `ConnectionProfileDTO` objects — **API keys are never exposed** (only a `has_api_key` boolean).

### `spindle.connections.list(userId?)`

List all connection profiles available to the user.

```ts
const connections = await spindle.connections.list()
// connections: Array<{ id, name, provider, model, is_default, has_api_key, ... }>

const defaultConn = connections.find(c => c.is_default)
if (defaultConn) {
  const result = await spindle.generate.quiet({
    messages: [{ role: 'user', content: 'Hello' }],
    connection_id: defaultConn.id,
  })
}
```

### `spindle.connections.get(connectionId, userId?)`

Get a single connection profile by ID. Returns `null` if not found.

```ts
const conn = await spindle.connections.get('some-connection-id')
if (conn) {
  spindle.log.info(`Using ${conn.provider} / ${conn.model}`)
}
```

### ConnectionProfileDTO

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique connection profile ID |
| `name` | `string` | Human-readable display name |
| `provider` | `string` | LLM provider identifier (e.g. `"openai"`, `"anthropic"`) |
| `api_url` | `string` | Custom API URL (empty string for default) |
| `model` | `string` | Selected model identifier |
| `preset_id` | `string \| null` | Associated generation preset |
| `is_default` | `boolean` | Whether this is the user's default connection |
| `has_api_key` | `boolean` | Whether an API key is configured (key itself is never exposed) |
| `metadata` | `Record<string, unknown>` | Provider-specific metadata |
| `created_at` | `number` | Unix timestamp |
| `updated_at` | `number` | Unix timestamp |

!!! note
    For user-scoped extensions, the `userId` parameter is automatically inferred from the extension owner. For operator-scoped extensions, pass `userId` to scope the query to a specific user.
