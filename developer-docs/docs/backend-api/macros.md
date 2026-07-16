# Macros

Register custom macros that users can use in their prompts and preset blocks with `{{macro_name}}` syntax.

Built-in macro resolution supports scoped blocks and control flow:

```txt
{{if::condition}}...{{elseif::other}}...{{else}}...{{/if}}
{{unless::condition}}...{{else}}...{{/unless}}

{{switch::value}}
{{case::a}}A branch{{/case}}
{{case::b::c}}B/C branch{{/case}}
{{default}}Fallback{{/default}}
{{/switch}}

{{let::name::value}}temporary local vars{{/let}}
{{map::a,b,c::x}}{{upper::{{.x}}}}{{/map}}
```

Only selected conditional/switch branches are resolved, so side-effect macros in unselected branches do not run.

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

If `updateMacroValue()` has never been called for a macro, the host falls back to invoking the handler via RPC at generation time. This is the original behavior and still works, but adds latency to prompt assembly (up to the 5-second timeout per macro). The public `handler` is an async JavaScript function body serialized as a string. The worker compiles it in strict mode with one `ctx` parameter. It is not an expression or function literal, cannot close over variables from the extension module, and is limited to 65,536 UTF-8 bytes. The handler source receives only `ctx`; direct lexical names for module, network, and runtime access (`require`, `module`, `process`, `Bun`, `fetch`, and related globals), worker transport/events (`postMessage`, `onmessage`, `addEventListener`, and related controls), and timer scheduling (`setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`, and their clear operations) are masked. This is cooperative containment in the same extension worker, not a separate security realm or OS-level isolation. `dynamic_code_execution` permits guarded `eval`/`Function` behavior for string-body execution; it does not make the handler an isolation boundary. Fetch or compute external data in extension code and push it with `updateMacroValue()`. Before a string-body registration becomes visible, the host applies the same capability scan used for installed backend source, including declared `dynamic_code_execution` and `base64_decode` capabilities and hard-blocked runtime modules.

```ts
spindle.registerMacro({
  name: 'weather',
  category: 'extension:my_extension',
  description: 'Returns the current weather (pull model)',
  returnType: 'string',
  handler: "return ctx.commit ? 'Sunny, 72°F' : 'Preview unavailable'",
})
```

!!! tip "When to use which"
    Use the push model whenever your extension already has the data available (polling loops, event listeners, cached state). Use the pull model only for macros whose values are impossible to pre-compute without the generation-time `MacroExecContext`.

### Handler Context: `ctx.commit`

Custom macro handlers receive a `commit` boolean on their execution context:

- `true` — normal committing execution
- `false` — dry / non-committing execution

This is primarily useful when your macro has separate display-only and state-mutating paths.

## Registration and value limits

The following limits are measured in **UTF-8 bytes** (not JavaScript character count) unless a count is shown:
The `returns` and `aliases` rows are host compatibility-envelope fields accepted in serialized registration payloads; they are not public `MacroDefinitionDTO` properties in the installed `lumiverse-spindle-types` types.

| Item | Maximum |
|---|---:|
| Macros per worker generation | 128 |
| Macro name | 128 B |
| Category | 256 B |
| Description | 4096 B |
| Host compatibility-envelope: `returns` metadata | 1024 B |
| Host compatibility-envelope: `aliases` | 32 aliases; 128 B each |
| Arguments | 32 args; each name 128 B and description 1024 B |
| Serialized handler body | 65536 B |
| Pushed cached value / pull result | 262144 B each |

Oversize registration payloads and `updateMacroValue()` updates are rejected atomically, leaving the previously accepted definition or cached value unchanged. An oversize pull result resolves as a safe empty failure and is not retained.

## MacroDefinitionDTO

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Macro name (used as `{{name}}` in prompts) |
| `category` | `string` | Category for grouping. Convention: `"extension:your_identifier"` |
| `description` | `string` | Shown in the macro reference panel |
| `returnType` | `"string" \| "integer" \| "number" \| "boolean"` | Optional. Default: `"string"` |
| `args` | `Array<{ name, description?, required? }>` | Optional argument definitions |
| `handler` | `string` | Pull handler source: an async JavaScript function body (maximum 65,536 UTF-8 bytes) compiled in strict mode with one `ctx` parameter. Use `return ...` for pull-model macros, or an empty/whitespace-only string as the push-model/no-handler sentinel. The host applies capability scanning and direct lexical masks before execution. |
| `volatile` | `boolean` | Optional. Default: `false`. Set `true` when output is nondeterministic or stateful; resolutions that include the macro bypass the display-regex cache. |

!!! note "Reading variables inside a handler"
    If your handler reads `ctx.env.variables.local` (or `.global`/`.chat`), use `.get(key)` and `.has(key)`. Iteration (`.entries()`, `.keys()`, `for...of`) isn't recorded in the per-resolution dependency fingerprint, so the cached output may be stale longer than expected when those vars change.

!!! note "When to set `volatile: true`"
    Set the flag when the handler's output isn't a pure function of its args and tracked env reads.
    **Needs the flag:** time based output (`Date.now()`, `new Date()`), random output (`Math.random()`), stateful side effects (read then write to a var, mutable internal counters), or external calls (HTTP, files, anything outside the env).
    **Doesn't need the flag (auto invalidates):** variable reads via `.get(key)` / `.has(key)` (the fingerprint records the dependency and the cache invalidates when that var changes), static fields on `env` (character, persona, scenario), and computed-from-tracked-inputs handlers (math, conditionals, string ops) where args evaluate through the same fingerprint mechanism so dependencies propagate.
    Rule of thumb: if the handler only touches `ctx.args` and `env.variables.<scope>.get(...)`, leave the flag off. If it reaches for `Date`, `Math.random`, or mutates state, set it.

!!! note "Resolution limits"
    Macro resolution is guarded by a work budget rather than a fixed shallow nesting-depth cap. Deep finite macro chains can resolve beyond 1000 levels, but recursive/explosive expansion is halted with diagnostics. List-style generators and iteration helpers still cap generated/iterated item counts at 1000.

## Methods

| Method | Description |
|---|---|
| `registerMacro(def)` | Register a macro with metadata and an optional handler |
| `unregisterMacro(name)` | Remove a registered macro |
| `updateMacroValue(name, value)` | Push the latest value for a registered macro (fire-and-forget) |

---

## Resolving Macros Programmatically

Resolve `{{macro}}` placeholders in caller-provided text using the full Lumiverse macro engine. Useful for extensions that build their own prompts and want to support the same macro syntax users are familiar with.

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
