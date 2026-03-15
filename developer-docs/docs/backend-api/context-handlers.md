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

!!! tip "Context Handlers vs Interceptors"
    **Context handlers** run _before_ prompt assembly and modify the context that drives assembly. **Interceptors** run _after_ assembly and modify the final message array. Use context handlers when you need to affect how the prompt is constructed; use interceptors when you need to tweak the finished output.
