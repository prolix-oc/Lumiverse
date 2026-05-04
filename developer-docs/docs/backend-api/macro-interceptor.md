# Macro Interceptor

!!! warning "Permission required: `macro_interceptor`"

Macro interceptors run at the top of `MacroEvaluator.evaluate()`, once per fixed-point iteration, before Lumi parses the template. They receive the raw template plus a read-only env snapshot, and return a transformed template or `void` to pass through.

```ts
spindle.registerMacroInterceptor(async (ctx) => {
  if (!ctx.template.includes('{{my_macro')) return
  return myInWorkerEvaluator(ctx.template, ctx.env)
}, 100)
```

Use this when per-macro RPC cost dominates iteration-heavy templates (`{{#each LARGE_LIST}}…{{my_macro}}…{{/each}}`). For single macros, prefer `registerMacro`.

## Parameters

| Param | Type | Description |
|---|---|---|
| `handler` | `(ctx: MacroInterceptorCtx) => Promise<string \| void>` | Returns the transformed template, or `void` to pass through |
| `priority` | `number` | Optional. Lower values run first. Default: `100` |

One interceptor per extension; a second registration replaces the first.

## Context Object

```ts
interface MacroInterceptorCtx {
  template: string
  env: { commit, names, character, chat, system, variables: { local, global, chat }, dynamicMacros, extra }
  commit: boolean
  phase: "prompt" | "display" | "response" | "other"
  sourceHint?: string
  userId?: string
}
```

`env` is a structured-clone snapshot. Persist state via `spindle.variables.*`, not the snapshot.

`env.dynamicMacros` carries per-call macro overrides supplied by the caller (`Record<string, string>`). The display-regex pipeline (`phase: "display"`) sets `chat_index` to the rendered message's index in the chat, which lets handlers compute per-message context that registered macros cannot reach on their own. Other callers may set additional fields.

## Composition Order

Multiple interceptors run in priority order (lower first), with registration order as the tie-breaker. Each interceptor receives the previous one's returned template.

If a returned template no longer contains `{{`, the iteration's parse and dispatch are skipped.

## Timeout

Each interceptor runs inside a 10-second wall-clock budget. On timeout or thrown error: the chain logs the failure and forwards the previous template to the next handler. Macro evaluation itself never aborts.

!!! warning "Users notice the wait"
    The interceptor fires inside every macro evaluation, including prompt assembly. Slow handlers add visible latency before the first streamed token.

## Macro Interceptor vs Interceptor vs Context Handler

| Hook | When it fires | What it changes |
| --- | --- | --- |
| **Macro Interceptor** | Per template, before parse | The raw template |
| [Context Handler](context-handlers.md) | Before prompt assembly | The generation context |
| [Interceptor](interceptors.md) | After assembly, before LLM call | The outgoing message array |
