# Interceptors

!!! warning "Permission required: `interceptor`"

Interceptors run after prompt assembly but before the messages reach the LLM provider. They can modify, add, or remove messages — and optionally inject generation parameters.

```ts
spindle.registerInterceptor(async (messages, context) => {
  // `messages` is an array of { role, content, name? }
  // `context` contains generation metadata (chatId, generationType, etc.)

  // Example: add a system message
  return [
    { role: 'system', content: '[Extension note] Be extra creative today.' },
    ...messages,
  ]
}, 50) // priority: lower runs first (default: 100)
```

## Parameters

| Param | Type | Description |
|---|---|---|
| `handler` | `(messages: LlmMessageDTO[], context: unknown) => Promise<LlmMessageDTO[] \| InterceptorResultDTO>` | Receives the current message array, must return the (modified) array or an `InterceptorResultDTO` |
| `priority` | `number` | Optional. Lower values run first. Default: `100` |

## Return Types

### Plain array (backwards-compatible)

Return a `LlmMessageDTO[]` to modify only the messages:

```ts
spindle.registerInterceptor(async (messages, context) => {
  return [
    { role: 'system', content: 'Extra instruction' },
    ...messages,
  ]
})
```

### InterceptorResultDTO (with parameter injection)

!!! warning "Additional permission required: `generation_parameters`"

Return an `InterceptorResultDTO` to modify both messages and generation parameters. This allows injecting provider-specific parameters like `response_format`, sampling overrides, or any other key into the outgoing LLM request.

```ts
interface InterceptorResultDTO {
  messages: LlmMessageDTO[]
  parameters?: Record<string, unknown>
}
```

```ts
spindle.registerInterceptor(async (messages, context) => {
  return {
    messages,
    parameters: {
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'prefill_output',
          schema: { type: 'object', properties: { text: { type: 'string' } } },
        },
      },
    },
  }
})
```

Without the `generation_parameters` permission, returned parameters are silently stripped. The extension still works as a message-only interceptor — just the parameters are ignored.

### Parameter merge order

Interceptor parameters are merged between the preset parameters and the user's request-level overrides:

```
preset parameters < interceptor parameters < request overrides
```

This means interceptor-injected parameters override preset defaults, but the user's explicit input parameters always take precedence.

When multiple interceptors inject parameters, they are merged in priority order (lower priority runs first). Later interceptors override earlier ones for the same key.

## LlmMessageDTO

```ts
interface LlmMessageDTO {
  role: "system" | "user" | "assistant"
  content: string
  name?: string
}
```

## Context Object

The `context` parameter is an object containing metadata about the current generation:

| Field | Type | Description |
|---|---|---|
| `chatId` | `string` | The chat being generated for |
| `connectionId` | `string` | The connection profile ID |
| `personaId` | `string` | The active persona ID |
| `generationType` | `string` | One of `"normal"`, `"continue"`, `"regenerate"`, `"swipe"`, `"impersonate"`, `"quiet"` |
| `activatedWorldInfo` | `array` | World info entries activated for this generation |

The context is read-only for informational purposes. To influence the generation, return modified messages or parameters.

## Timeout

Interceptors run inside a wall-clock budget. When the budget is exceeded, the interceptor is skipped and the pre-interceptor messages are passed through unchanged — the generation still proceeds.

The budget is resolved **per run**, immediately before each invocation, in this order:

1. **`interceptorTimeoutMs` in your `spindle.json`** — a per-extension override shipped with the manifest
2. **`spindleSettings.interceptorTimeoutMs`** — the user's setting (adjustable in the Spindle panel)
3. **Default `10000` ms** — applied when neither of the above is set

All values are clamped to **`[1000, 300000]` ms** (1 second to 5 minutes).

Because resolution is per-run, users can change the Spindle timeout in the Spindle panel and the new value takes effect on the next generation — your extension does not need to re-register.

### Picking a timeout

The default 10 s covers simple prompt shaping. If your interceptor does real pre-generation work — multi-step retrieval, graph traversal, controller-driven context assembly, or external API calls — bump the manifest value to match your expected worst-case latency:

```json
{
  "identifier": "my_retrieval_extension",
  "permissions": ["interceptor"],
  "interceptorTimeoutMs": 45000
}
```

!!! warning "Users notice the wait"
    The interceptor runs **before** the LLM call, so every millisecond of interceptor work is a millisecond of visible silence before the first streamed token. Ship the tightest timeout that still accommodates your worst case, not the largest value you can get away with.

### What happens on timeout

When your handler exceeds the budget, the host:

1. Rejects the pending RPC with an `Interceptor timeout from <your_id> (Ns)` error
2. Logs `[Spindle] Interceptor error from <your_id>:` with the rejection
3. **Passes the last-known message list through** to the next interceptor (or to the LLM if you were last)

This means a partial failure in your extension will never block the user's generation — it just means your modifications didn't land. Design your interceptor so that a timeout is a graceful no-op rather than a corrupted prompt.
