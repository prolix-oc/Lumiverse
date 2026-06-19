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
| `tools` | `ToolSchemaDTO[]` | Optional. Function/tool schemas exposed to the model (raw / quiet only). See Tool calling below |
| `reasoning` | `GenerationReasoningOverrideDTO` | Optional. Per-request override for extended-thinking settings — see Reasoning below |
| `signal` | `AbortSignal` | Optional. Cancel the in-flight LLM request when the signal fires (see Cancellation below) |

---

## Tool calling

Pass tool schemas via `tools` and the model can call them. Tool calls land in `response.tool_calls` (non-stream) or the terminal `done` chunk (stream) as `ToolCallDTO[]`. You execute the tool, then send the result back as a `tool_result` part on the next user message.

```ts
const result = await spindle.generate.raw({
  type: 'raw',
  messages: [{ role: 'user', content: 'What is the weather in SF?' }],
  tools: [{
    name: 'get_weather',
    description: 'Look up current weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  }],
})

// result.tool_calls?.[0] = { name: 'get_weather', args: { city: 'SF' }, call_id: 'toolu_…' }
```

Round-trip the call by appending two messages: an `assistant` with a `tool_use` part carrying the same `call_id`, then a `user` with a `tool_result` part keyed back to it.

```ts
const followup = await spindle.generate.raw({
  type: 'raw',
  messages: [
    { role: 'user', content: 'What is the weather in SF?' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_abc', name: 'get_weather', input: { city: 'SF' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_abc', content: '72F, clear' },
      ],
    },
  ],
  tools: [/* same schema */],
})
```

### Parts

| Type | Fields | Used by |
|---|---|---|
| `text` | `text: string` | Any role |
| `image` | `data: string` (base64), `mime_type: string` | `user` |
| `audio` | `data: string` (base64), `mime_type: string` | `user` |
| `tool_use` | `id`, `name`, `input: Record<string, unknown>` | `assistant` |
| `tool_result` | `tool_use_id`, `content: string`, `is_error?: boolean` | `user` |

Use the same `call_id` returned in `ToolCallDTO` as `tool_use.id` and `tool_result.tool_use_id`. Provider adapters translate to each upstream's native shape (Anthropic content blocks, OpenAI `tool_calls` / `role:"tool"`, Gemini `functionCall` / `functionResponse`, OpenAI Responses API `function_call` / `function_call_output`).

!!! note "Tool result formatting"
    Anthropic requires the `tool_result` parts to come first in the content array of the user message that follows an assistant `tool_use`. The host enforces this; you just need to put them in a dedicated user message that immediately follows.

### ToolSchemaDTO

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Function name the model uses to invoke the tool |
| `description` | `string` | Natural-language description shown to the model |
| `parameters` | `JSONSchema` | JSON Schema for the call arguments |

### ToolCallDTO

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Tool name matching one of your `ToolSchemaDTO` entries |
| `args` | `Record<string, unknown>` | Parsed JSON arguments |
| `call_id` | `string` | Provider call id (Anthropic `id`, OpenAI `id`, synthetic UUID for Gemini). Pass back as `tool_use.id` / `tool_result.tool_use_id` |

---

## Reasoning / extended thinking

Most modern frontier models expose a "thinking" knob — Anthropic's `thinking` block, Google's `thinkingConfig`, DeepSeek's `reasoning_effort`, the OpenAI-compatible `reasoning.effort`, and so on. Lumiverse wraps that surface in a single high-level shape so extensions don't have to encode each provider's quirks.

By default, every generation request inherits the **resolved user reasoning settings**:

1. If the request resolves a connection (`connection_id`, or `quiet` resolving the user's active connection) and that connection has a binding (`metadata.reasoningBindings`), the binding wins.
2. Otherwise the user's global `reasoningSettings` is applied.
3. The host translates the resolved `{ apiReasoning, reasoningEffort, thinkingDisplay }` into the provider-specific parameters before dispatching the request.

You can inspect what a connection is bound to via [`spindle.connections.get()`](#connection-profiles) — the `reasoning_bindings` field is the parsed, typed view.

### Per-request override

Pass `reasoning` on any `generate.*` call to bypass the inherited settings for that single request:

```ts
// Force thinking off — cheaper one-shot summarization on a connection
// that normally has high-effort reasoning enabled.
await spindle.generate.raw({
  messages: [{ role: 'user', content: 'TL;DR this paragraph.' }],
  connection_id: connId,
  reasoning: { source: 'off' },
})

// Crank the effort up just for this one call.
await spindle.generate.quiet({
  messages,
  reasoning: { source: 'custom', apiReasoning: true, effort: 'max' },
})

// Anthropic — opt into summarised thinking blocks for this call.
await spindle.generate.raw({
  messages,
  connection_id: anthropicConnId,
  reasoning: {
    source: 'custom',
    apiReasoning: true,
    effort: 'high',
    thinkingDisplay: 'summarized',
  },
})

// Echo the connection's bound settings back, then dial effort up one tier.
const conn = await spindle.connections.get(connId)
const bound = conn?.reasoning_bindings?.settings
if (bound?.apiReasoning) {
  await spindle.generate.rawStream({
    messages,
    connection_id: connId,
    reasoning: { source: 'custom', apiReasoning: true, effort: 'max' },
  })
}
```

### GenerationReasoningOverrideDTO

| Field | Type | Description |
|---|---|---|
| `source` | `"inherit" \| "off" \| "custom"` | Default `"inherit"` — apply the connection binding then fall back to the user setting. `"off"` strips every provider reasoning field and applies the off-switch unconditionally. `"custom"` uses the explicit fields below. |
| `apiReasoning` | `boolean` | Used when `source === "custom"`. Defaults to `true`. Set `false` to mean the same thing as `source: "off"`. |
| `effort` | `ReasoningEffortDTO` | Used when `source === "custom"`. One of `"auto" \| "none" \| "minimal" \| "low" \| "medium" \| "high" \| "max" \| "xhigh"`. Defaults to `"auto"`. |
| `thinkingDisplay` | `ThinkingDisplayDTO` | Anthropic-only. One of `"auto" \| "summarized" \| "omitted"`. Maps to `thinking.display`. Defaults to `"auto"` (model-specific default). |

### Precedence

Raw values supplied in `parameters` still take precedence at the field level. The override only fills in fields that aren't already set on the request — the same behaviour as the inherited settings. The single exception is `source: "off"` (or `source: "custom", apiReasoning: false`), which unconditionally strips `thinking` / `thinkingConfig` / `reasoning` / `reasoning_effort` and applies the provider's documented off-switch.

That means an extension can opt out of host translation entirely by writing the provider-specific shape into `parameters` directly — `reasoning` is only a convenience layer.

### Provider mapping

| Provider | `apiReasoning: true` produces | Effort handling |
|---|---|---|
| Anthropic (Claude 4.6+ adaptive) | `thinking: { type: "adaptive" }` + `output_config.effort` | `low \| medium \| high \| max` (+ `xhigh` on Opus 4.7) |
| Anthropic (legacy) | `thinking: { type: "enabled", budget_tokens: N }` | `low=2048, medium=8192, high=16384, max=32768` |
| Google (Gemini / Vertex) | `thinkingConfig: { thinkingLevel, includeThoughts: true }` | `minimal \| low \| medium \| high` |
| DeepSeek | `thinking: { type: "enabled" }` + `reasoning_effort` | `low/medium/high → "high"`, `max/xhigh → "max"` |
| OpenRouter | `reasoning: { effort }` | `none \| minimal \| low \| medium \| high \| xhigh` |
| NanoGPT | `reasoning: { effort }` (object form preserves `exclude` / `delta_field`) | `none \| minimal \| low \| medium \| high` |
| Moonshot, Z.AI | `thinking: { type: "enabled" }` (toggle-only) | Effort ignored — `apiReasoning` alone gates it |
| Generic OpenAI-compatible | `reasoning: { effort }` | Passed verbatim |

When `apiReasoning: false` the host writes the provider's documented "no extended thinking" shape — `thinking: { type: "disabled" }` for Anthropic and DeepSeek, `reasoning: { exclude: true }` for NanoGPT, omission for everyone else.

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
| `type` | `string` | Block type: `"block"`, `"chat_history"`, `"world_info"`, `"authors_note"`, `"utility"`, `"long_term_memory"`, `"separator"`, `"append"`, `"sidecar"`, `"extension"`. |
| `name` | `string` | Human-readable block name. |
| `role` | `string` | Message role (`"system"`, `"user"`, `"assistant"`). |
| `content` | `string` | The resolved text content. |
| `blockId` | `string` | Preset block ID (if from a preset block). |
| `extensionId` | `string` | Present for interceptor-injected breakdown blocks. Resolved from the installed extension manifest. |
| `extensionName` | `string` | Human-readable extension attribution for interceptor-injected breakdown blocks. |

When an interceptor returns `breakdown: [{ messageIndex, name? }]`, the host turns those referenced messages into `type: "extension"` breakdown entries. This means retrieval or prompt-engineering extensions can expose their injected context in both dry-run results and persisted prompt breakdown snapshots without having to parse or diff the final prompt themselves.

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
| `retrievalMode` | `string?` | How chunks were retrieved: `"vector"` (real vector/hybrid search) or `"recency"` (fallback, e.g. the query embedding failed). `retrievedChunks[].score` is `null` for recency/keyword-only hits. |
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
| `metadata` | `Record<string, unknown>` | Raw provider-specific metadata bag (Anthropic caching flags, Google thinking budget config, the unparsed `reasoningBindings` blob, etc.) |
| `reasoning_bindings` | `ConnectionReasoningBindingsDTO \| null` | Typed view of the connection's bound reasoning settings, parsed from `metadata.reasoningBindings`. `null` when nothing is bound — generation falls back to the user's global `reasoningSettings` in that case. |
| `created_at` | `number` | Unix timestamp |
| `updated_at` | `number` | Unix timestamp |

### ConnectionReasoningBindingsDTO

When a user binds reasoning settings to a connection from the Connection Manager UI, the snapshot is exposed here so extensions can inspect it without grovelling through `metadata`.

| Field | Type | Description |
|---|---|---|
| `settings` | `ReasoningSettingsDTO` | The bound reasoning snapshot — see below. |
| `promptBias` | `string` | Optional. Bound "Start Reply With" assistant prefill captured alongside the reasoning snapshot. Overrides the user's global `promptBias` for this connection. |

### ReasoningSettingsDTO

| Field | Type | Description |
|---|---|---|
| `apiReasoning` | `boolean` | Master switch — whether the provider should produce thinking output. |
| `reasoningEffort` | `ReasoningEffortDTO` | One of `"auto" \| "none" \| "minimal" \| "low" \| "medium" \| "high" \| "max" \| "xhigh"`. See the [provider mapping table](#provider-mapping). |
| `thinkingDisplay` | `ThinkingDisplayDTO` | Anthropic-only. `"auto" \| "summarized" \| "omitted"`. |
| `prefix` | `string` | Opening delimiter for the delimited-reasoning parser (e.g. `"<think>\n"`). Only affects parsing, not the outgoing request. |
| `suffix` | `string` | Closing delimiter for the delimited-reasoning parser. |
| `autoParse` | `boolean` | Whether to auto-parse delimited reasoning out of the assistant content stream. |
| `keepInHistory` | `number` | How many recent reasoning blocks to retain in assembled prompt history. `0` strips all, `-1` keeps everything, `N` keeps the last N. |

```ts
const conn = await spindle.connections.get(connId)
if (conn?.reasoning_bindings) {
  const { apiReasoning, reasoningEffort } = conn.reasoning_bindings.settings
  spindle.log.info(
    `Bound: thinking=${apiReasoning}, effort=${reasoningEffort}`,
  )
}
```

!!! note
    For user-scoped extensions, the `userId` parameter is automatically inferred from the extension owner. For operator-scoped extensions, pass `userId` to scope the query to a specific user.
