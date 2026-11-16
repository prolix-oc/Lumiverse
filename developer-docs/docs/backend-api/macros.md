# Macros

Register custom macros that users can use in their prompts and preset blocks with `{{macro_name}}` syntax.

Macro names are ownership-protected. An extension may replace or unregister only its own registrations. System macros always take precedence; preset/request dynamic macros take precedence over extension macros with the same name.

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

The host built-ins `{{lastPreset}}` and `{{lastPresets::count::separator}}` return preset names from selected assistant swipes, newest first, preserving repeats. Count defaults to 1 and is capped at 100; the default separator is a newline. Missing provenance returns empty, and names remain literal data. Regeneration uses the target's original selection. These built-ins do not replace extension-owned rendering or extend the separate prompt-activation find-pattern whitelist.

Macro-resolution fingerprints may include the reserved read-only dependency `context:presetHistory:<chatId>` alongside variable reads. A cache consuming these fingerprints must invalidate history-dependent entries when selected attribution changes, including when an empty result becomes available; it must not interpret this key as a persisted variable. Host result caches validate the current history value. Extension-owned resolvers remain responsible for their own caching and context.

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
| `volatile` | `boolean` | Optional. Set `true` when the macro returns different output across calls with the same args (time, randomness, idle duration, etc.) so the display-regex cache doesn't store the result as static. |

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

## Macro Interceptors

`spindle.registerMacroInterceptor(handler, priority?, opts?)` requires the `macro_interceptor` permission. The async handler receives `ctx.template` and a read-only environment snapshot before native macro parsing. It returns a string, `{ text, touchedVars?, volatile? }`, or `void` to pass through. Lower priorities run first; the default is `100`. Registering again replaces your extension's previous handler.

Set `opts.handlesOwnedSources: true` to exclusively resolve macro-bearing regex templates whose `owner_extension_identifier` matches your extension. These calls include `ctx.sourceOwner.extensionIdentifier` and receive the unmodified template. Return a string or a result object: the host uses its text verbatim without native evaluation or other interceptors. A missing result, thrown error, or timeout rejects the owned evaluation. Templates without macros skip dispatch; other templates retain normal chain behavior, which logs interceptor failures and continues.

With this opt-in, stored messages on characters whose extension namespace has `display_owner: true` also remain verbatim for the extension's [display pipeline](../frontend-api/display-resolver.md#ownership).

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
