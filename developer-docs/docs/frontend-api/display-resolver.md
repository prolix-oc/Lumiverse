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
| `applyScripts` | Run the chat's display regex scripts over the content |
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

The method-specific arguments alongside `context` are: `content` for `resolveBody`, `templates` (a `Record<key, string>`) for `resolveTemplates`, and `content` plus `scripts` for `applyScripts`.

### Result

`resolveBody` and `applyScripts` return:

| Field | Type | Description |
|---|---|---|
| `content` | `string` | The resolved output |
| `touchedVars` | `string[]?` | Variables this result depends on, as `scope:name` (e.g. `chat:mood`, `global:lang`) |
| `cacheable` | `boolean?` | Set `false` to never cache this result. Defaults to cacheable |

`resolveTemplates` returns the same information keyed per template: `resolved` (`Record<key, string>`), and optional `touchedVars` (`Record<key, string[]>`) and `cacheable` (`Record<key, boolean>`).

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

The hook is frontend only and requires no permission.
