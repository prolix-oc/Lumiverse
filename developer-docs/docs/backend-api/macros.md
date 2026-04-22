# Macros

Register custom macros that users can use in their prompts and preset blocks with `{{macro_name}}` syntax.

## Push Model (recommended)

The push model lets your extension proactively send the latest macro value to the host. During prompt assembly the host returns the cached value instantly — no RPC roundtrip to the worker, no risk of stalling generation.

1. **Register** the macro (metadata only — the handler can be empty).
2. **Push** the value with `updateMacroValue()` whenever the underlying data changes.

```ts
// Register macro metadata at startup
spindle.registerMacro({
  name: 'weather',
  category: 'extension:my_extension',
  description: 'Returns the current weather',
  returnType: 'string',
  handler: '',  // not used — values are pushed
})

// Push the value whenever it changes (e.g. from a polling loop)
setInterval(async () => {
  const weather = await fetchWeather()
  spindle.updateMacroValue('weather', `${weather.condition}, ${weather.temp}°F`)
}, 60_000)

// Unregister later
spindle.unregisterMacro('weather')
```

`updateMacroValue(name, value)` is fire-and-forget — it posts the value to the host and returns immediately. The onus of data freshness is on the extension; the backend simply uses whatever was last pushed.

## Pull Model (legacy)

If `updateMacroValue()` has never been called for a macro, the host falls back to invoking the handler via RPC at generation time. This is the original behavior and still works, but adds latency to prompt assembly (up to the 5-second timeout per macro).

```ts
spindle.registerMacro({
  name: 'weather',
  category: 'extension:my_extension',
  description: 'Returns the current weather (pull model)',
  returnType: 'string',
  handler: (ctx) => ctx.commit ? 'Sunny, 72°F' : 'Preview unavailable',
})
```

!!! tip "When to use which"
    Use the push model whenever your extension already has the data available (polling loops, event listeners, cached state). Use the pull model only for macros whose values are impossible to pre-compute without the generation-time `MacroExecContext`.

### Handler Context: `ctx.commit`

Custom macro handlers receive a `commit` boolean on their execution context:

- `true` — normal committing execution
- `false` — dry / non-committing execution

This is primarily useful when your macro has separate display-only and state-mutating paths.

## MacroDefinitionDTO

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Macro name (used as `{{name}}` in prompts) |
| `category` | `string` | Category for grouping. Convention: `"extension:your_identifier"` |
| `description` | `string` | Shown in the macro reference panel |
| `returnType` | `"string" \| "integer" \| "number" \| "boolean"` | Optional. Default: `"string"` |
| `args` | `Array<{ name, description?, required? }>` | Optional argument definitions |
| `handler` | `function \| ""` | Optional macro handler. Use a function for pull-model macros, or an empty string when using the push model. |

## Methods

| Method | Description |
|---|---|
| `registerMacro(def)` | Register a macro with metadata and an optional handler |
| `unregisterMacro(name)` | Remove a registered macro |
| `updateMacroValue(name, value)` | Push the latest value for a registered macro (fire-and-forget) |

---

## Resolving Macros Programmatically

Resolve `{{macro}}` placeholders in arbitrary text using the full Lumiverse macro engine. Useful for extensions that build their own prompts and want to support the same macro syntax users are familiar with.

### `spindle.macros.resolve(template, options?)`

```ts
const { text } = await spindle.macros.resolve(
  'Hello {{user}}, I am {{char}}! The scenario is: {{scenario}}',
  { chatId: 'abc123', characterId: 'xyz456' },
)
```

| Parameter | Type | Description |
|---|---|---|
| `template` | `string` | Text containing `{{macro}}` placeholders |
| `options.chatId` | `string?` | Chat ID for full context (messages, variables, etc.) |
| `options.characterId` | `string?` | Character ID (inferred from chat if omitted) |
| `options.userId` | `string?` | For operator-scoped extensions only |
| `options.commit` | `boolean?` | Defaults to `true`. Set to `false` for a dry / non-committing resolve. |

**Returns:** `Promise<{ text: string; diagnostics: Array<{ message: string; offset: number; length: number }> }>`

- `text` — the fully resolved string
- `diagnostics` — any warnings from the macro engine (unknown macros, evaluation errors, etc.)

### Dry / Non-Committing Resolves

Use `commit: false` when you want rendered text without allowing the resolve path to persist side effects.

```ts
const { text } = await spindle.macros.resolve(template, {
  chatId: activeChatId,
  characterId: activeCharacterId,
  commit: false,
})
```

When `commit: false` is active:

- extension macro handlers receive `ctx.commit === false`
- host-backed mutating Spindle APIs called from that macro invocation reject instead of persisting changes
- nested `spindle.macros.resolve()` calls inherit the current commit mode unless you explicitly override it

This lets extensions cleanly separate preview/display parsing from generation-time state mutation.

### Context Levels

The macros that resolve depend on how much context you provide:

| Context Provided | Available Macros |
|---|---|
| Nothing | Time/date (`{{time}}`, `{{date}}`), random (`{{random}}`), primitives (`{{space}}`, `{{newline}}`) |
| `characterId` only | Above + character fields (`{{char}}`, `{{description}}`, `{{personality}}`, `{{scenario}}`, etc.) |
| `chatId` + `characterId` | Above + chat context (`{{lastMessage}}`, `{{messageCount}}`, variables (`{{getvar::key}}`), etc.) |

### Example: Custom Prompt with Macros

```ts
const template = `You are {{char}}. {{personality}}
The current scenario: {{scenario}}
There are {{messageCount}} messages in this conversation.`

const { text } = await spindle.macros.resolve(template, {
  chatId: activeChatId,
  characterId: activeCharacterId,
})

const result = await spindle.generate.quiet({
  messages: [
    { role: 'system', content: text },
    { role: 'user', content: 'Continue the story.' },
  ],
})
```

!!! tip "Macros vs Generate"
    `generate.quiet()` and `generate.raw()` do **not** resolve macros in messages — they send them directly to the LLM provider. Use `spindle.macros.resolve()` to expand macros before passing text to generation.
