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

!!! note "Timeout"
    Interceptors that take longer than 10 seconds are skipped, and the previous messages are passed through.
