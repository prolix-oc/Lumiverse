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
  handler: 'return "Sunny, 72°F"',
})
```

!!! tip "When to use which"
    Use the push model whenever your extension already has the data available (polling loops, event listeners, cached state). Use the pull model only for macros whose values are impossible to pre-compute without the generation-time `MacroExecContext`.

## MacroDefinitionDTO

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Macro name (used as `{{name}}` in prompts) |
| `category` | `string` | Category for grouping. Convention: `"extension:your_identifier"` |
| `description` | `string` | Shown in the macro reference panel |
| `returnType` | `"string" \| "integer" \| "number" \| "boolean"` | Optional. Default: `"string"` |
| `args` | `Array<{ name, description?, required? }>` | Optional argument definitions |
| `handler` | `string` | Serialized function body that returns the macro value. Can be empty when using the push model. |

## Methods

| Method | Description |
|---|---|
| `registerMacro(def)` | Register a macro with metadata and an optional handler |
| `unregisterMacro(name)` | Remove a registered macro |
| `updateMacroValue(name, value)` | Push the latest value for a registered macro (fire-and-forget) |
