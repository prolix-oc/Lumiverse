# Display Resolver

Display resolution turns stored message content into what the user sees: macro expansion, format transforms, and regex display scripts. By default the host runs this on the backend and the frontend fetches the result. An extension can register a frontend resolver to do that work in the browser instead, for chats it owns. This removes a backend round trip per render and lets you run your own resolution engine client side.

`ctx.display` is optional. Feature-detect it before use.

```ts
export function setup(ctx: SpindleFrontendContext) {
  if (!ctx.display) return // host build without the display hook

  const unregister = ctx.display.registerResolver(myResolver)

  return () => unregister()
}
```

## Ownership

The host consults your resolver only for chats it owns, and uses its own backend resolution for everything else. You own a chat by setting `display_owner: true` in your own namespaced character data, alongside whatever else you store there:

```ts
// backend, when you write per-character state
await characters.update(characterId, {
  extensions: { my_extension: { ...myData, display_owner: true } },
}, userId)
```

A chat is owned when its character's `extensions["my_extension"].display_owner` is `true` and your extension is enabled. Storing data under your namespace without the flag does not claim display, so set it only on characters you actually render. To stop owning a character, set it `false`.

Vanilla chats, and chats whose character only carries other extensions' data, are never routed to you.

## `ctx.display.registerResolver(resolver)`

Register your resolver. Returns an unregister function. The resolver implements four methods the host calls while rendering messages.

```ts
const myResolver: SpindleDisplayResolver = {
  ready: (chatId) => true,
  resolveBody: async ({ content, context }) => ({
    content: transform(content),
    touchedVars: ['chat:mood'],
  }),
  resolveTemplates: async ({ templates, context }) => ({ resolved: { /* key: value */ } }),
  applyScripts: async ({ content, scripts, context }) => ({ content: applied }),
}
```

| Method | Purpose |
|---|---|
| `resolveBody` | Transform a full message body (macro expansion, format passes) |
| `resolveTemplates` | Pre-resolve a batch of named templates, such as regex find/replace strings |
| `applyScripts` | Apply display regex scripts and finalize body processing |
| `ready(chatId)` | Return whether your resolver can handle this chat right now |

Return `null` from any resolve method to let the host resolve that one with its own path (only for chats you do not own; for owned chats a `null` return shows raw, never a backend fallback).

For a chat you own, the host calls a resolve method only once `ready(chatId)` returns `true`. While it is `false` (your bundle still loading, snapshot not yet arrived) the host shows raw content and does not fall back to backend resolution. Return `true` as soon as you can resolve the chat, and call `invalidate` when your readiness or state changes so the host re-renders.

### Context

Each resolve method receives a `context`:

| Field | Type | Description |
|---|---|---|
| `chatId` | `string?` | Chat being rendered |
| `characterId` | `string?` | Active character |
| `personaId` | `string?` | Active persona |
| `messageId` | `string?` | Message being rendered |
| `messageIndex` | `number?` | Position of the message in the chat |
| `role` | `string?` | Message role |
| `isUser` | `boolean` | Whether the message is from the user |
| `depth` | `number` | Message depth |
| `dynamicMacros` | `Record<string, string>?` | Per-call macro values supplied by the host |
| `presetContext` | `MessagePresetContextDTO?` | Preset and saved variables for the selected swipe |
| `presetRegexIds` | `string[]?` | IDs of that preset's regexes, supplied to `resolveTemplates` and `applyScripts` |

The method-specific arguments alongside `context` are: `content` for `resolveBody`, `templates` (a `Record<key, string>`) for `resolveTemplates`, and `content`, `scripts`, plus optional `processingState` for `applyScripts`.

### Result

`resolveBody` and `applyScripts` return:

| Field | Type | Description |
|---|---|---|
| `content` | `string` | The resolved output |
| `processingState` | `string?` | Opaque state returned by `resolveBody` and passed to `applyScripts` with that content, including cache hits. Frontend only; never sent to the backend |
| `touchedVars` | `string[]?` | Variables this result depends on, as `scope:name` (e.g. `chat:mood`, `global:lang`) |
| `cacheable` | `boolean?` | Set `false` to never cache this result. Defaults to cacheable |

`resolveTemplates` returns the same information keyed per template: `resolved` (`Record<key, string>`), and optional `touchedVars` (`Record<key, string[]>`) and `cacheable` (`Record<key, boolean>`).

## Regex waits for your resolver

For chats you own, the host does not run display regex scripts against content your `resolveBody` has not processed yet: the regex pass waits until your result settles, then runs on it.

Set `finalizeWithoutScripts: true` on your resolver to receive `applyScripts` calls with `scripts: []` when no display scripts are active. This opt-in lets your resolver finalize the body; omitted or false preserves the existing no-script bypass. Script results are reused only when `processingState` also matches; an empty string and an omitted state are distinct.

Returning `null` (or throwing) from `resolveBody` shows the raw content for that render without caching it as resolved, so later renders retry.

## Streaming scheduling

Each mounted message keeps one active body-resolution pass and one active script-application pass. Each stage retains only its newest pending input and starts it when the active pass finishes. There is no fixed debounce interval. Resolvers must accept full snapshots; intermediate token revisions may never be submitted.

Completed append-only prefixes can advance the visible message while a newer snapshot is pending. Rewrites, new streams, context invalidations and unmounts prevent obsolete completions from being applied. The final authoritative message still passes through preprocessing and script application as needed.

For host-owned display, a missing required terminal literal can prove that a script cannot match before any worker or backend dispatch. This uses a cached literal guard, not execution of the user-authored regex. Patterns outside the recognized subset keep isolated execution. Trimming, repeat-back, macro side effects and ordered replacement chains retain their semantics. Extension-owned resolvers remain authoritative and bypass this host guard.

## Per-swipe presets

Requires host capability `message-preset-context-v1: 1`. Store
`{ preset_id, variables? }` entries in `message.extra.spindle_metadata.preset_contexts`,
matching the indexes in `message.swipes`. Use `null` for normal rendering.
The host keeps entries aligned when swipes are added or deleted.

Each swipe uses its preset's current enabled regexes in place of the active
preset's regexes. They run in order against the whole message, preserving nested
replacements, anchors, and lookarounds. Global, character, chat, and extension
rules keep their scope and order. The active preset and saved rules stay unchanged.
Deleted or inaccessible presets never fall back to the active preset's regexes.

Save `dryRun.variable_state` as `variables` to reuse the values from prompt
assembly. It contains `local`, `global`, `chat`, and `prompt_defaults` string
records, plus `prompt_selections` string-array records. Each field is optional
in a saved entry.

Custom resolvers receive `presetContext` and must apply its variables themselves.
Use `presetRegexIds` to identify the preset's rules and keep their variables
separate from your character state. Copy the saved variables before changing
them during rendering. Messages without an entry use normal rendering and
receive neither field.

## Caching and invalidation

The host caches your results so it does not call you on every render, using `touchedVars` as the dependency key. When a variable changes, only cached entries that listed it are dropped. Mark a result `cacheable: false` if it depends on something that is not a variable (time, randomness).

When your own state changes, tell the host which entries to drop:

```ts
// Drop cached resolutions that depend on these variables
ctx.display.invalidate(['chat:mood', 'global:lang'])

// Drop all cached display resolutions for the active chat
ctx.display.invalidate(['*'])
```

`invalidate` takes a list of `scope:name` strings, or `['*']` to clear everything. Use the wholesale form after a change you cannot express as a small set of variables, such as switching the chat your extension owns.

Use `setExpression` when display resolution selects an expression image:

```ts
ctx.display.setExpression({ chatId, characterId, label, imageId })
```

The update is transient and frontend only. It is ignored when `chatId` is not
the active chat.

The hook is frontend only and requires no permission.

## Preserve authored formatting

Set `skipFormattingHealing: true` on the registered resolver to disable automatic quote, emphasis-whitespace, and font-tag repairs in message bodies for the active chat owned by your extension. This option defaults to `false`; other chats keep normal formatting healing. Registration, disposal, and ownership changes update displayed messages immediately. Set the option at registration time, rather than mutating it afterward.

This does not disable Markdown rendering, HTML sanitization, or change prompt processing or reasoning blocks.
