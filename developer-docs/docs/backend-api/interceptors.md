# Interceptors

!!! warning "Permission required: `interceptor`"

Interceptors run after prompt assembly but before the messages reach the LLM provider. They can modify, add, or remove messages.

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
| `handler` | `(messages: LlmMessageDTO[], context: unknown) => Promise<LlmMessageDTO[]>` | Receives the current message array, must return the (modified) array |
| `priority` | `number` | Optional. Lower values run first. Default: `100` |

## LlmMessageDTO

```ts
interface LlmMessageDTO {
  role: "system" | "user" | "assistant"
  content: string
  name?: string
}
```

!!! note "Timeout"
    Interceptors that take longer than 10 seconds are skipped, and the previous messages are passed through.
