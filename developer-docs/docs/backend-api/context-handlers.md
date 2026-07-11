# Context Handlers

!!! warning "Permission required: `context_handler`"

Context handlers run *before* prompt assembly. They can enrich or modify the generation context that feeds into the assembler.

```ts
spindle.registerContextHandler(async (context) => {
  // Add custom data to the generation context
  return {
    ...context,
    myExtensionData: {
      customField: 'value',
    },
  }
}, 50) // priority: lower runs first (default: 100)
```

Use this when you need to influence how the prompt is built rather than modifying the final messages.

## Generation context

The context object carries:

| Field | Type | Description |
| --- | --- | --- |
| `chatId` | `string` | Chat the generation targets. |
| `generationType` | `string` | `'normal'`, `'continue'`, `'regenerate'`, `'swipe'`, or `'impersonate'`. |
| `dryRun` | `boolean` | `true` for tokenize/preview assemblies that never reach an LLM. Skip side effects when set. |
| `userId` | `string` | Requesting user. |

Hosts that stamp these fields advertise it via `spindle.contracts.preAssemblyGenerationContext >= 1`. Check the contract before relying on them:

```ts
if ((spindle.contracts?.preAssemblyGenerationContext ?? 0) >= 1) {
  spindle.registerContextHandler(handler)
}
```

## Cancelling a generation

Return the context with `cancelGeneration: true` to stop the generation before any LLM call. The host routes this through the same path as a user-initiated stop.

```ts
spindle.registerContextHandler(async (context) => {
  if (await shouldBlock(context)) {
    return { ...context, cancelGeneration: true }
  }
  return context
})
```

## Timeout

Each invocation runs inside a 10-second wall-clock budget by default. Handlers that legitimately need longer can request a bigger budget at registration (clamped to 1s–120s):

```ts
spindle.registerContextHandler(handler, 100, { timeoutMs: 30_000 })
```

On timeout the host logs an error and continues with the previous context, so a slow handler delays but never blocks generation.

!!! tip "Context Handlers vs Interceptors"
    **Context handlers** run _before_ prompt assembly and modify the context that drives assembly. **Interceptors** run _after_ assembly and modify the final message array. Use context handlers when you need to affect how the prompt is constructed; use interceptors when you need to tweak the finished output.
