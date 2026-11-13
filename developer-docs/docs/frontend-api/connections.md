# Connection profiles

`ctx.connections` reads the user's connection profiles from the frontend. Reads
are free. Switching or editing the active LLM profile needs `generation`.

## Every kind

Feature-detect `ctx.host.capabilities['connection-kinds-v1'] >= 1`. Older hosts
ignore the `kind` argument and return LLM profiles.

```ts
if ((ctx.host.capabilities['connection-kinds-v1'] ?? 0) >= 1) {
  const voices = await ctx.connections.list({ kind: 'tts' })
  // [{ id, kind: 'tts', name, provider, model, voice, active }]
  if (ctx.connections.getActive) {
    const stt = await ctx.connections.getActive('stt')
    // { activeProfileId, provider, model }; all null when the kind has no active profile
  }
}
```

`kind` is one of `llm`, `image`, `tts`, `stt`, `embedding`, `decision`.
`list({ kind })` resolves to summaries with `id`, `kind`, `name`, `provider`,
`model`, `active`, and `voice` (TTS only). Summaries never contain API keys,
endpoint URLs, headers, metadata, or provider parameters.

Speech profile lists load on demand through the host, including in native widget
windows that have no preloaded connection cache. An empty array means no saved
profiles were returned; a loading failure rejects the promise. Extensions can
reload on reconnect, focus, or an explicit refresh without periodic polling.

`active` marks the profile Lumiverse itself uses for that kind when no
connection id is given:

| Kind | Active profile |
| --- | --- |
| `llm` | The active connection |
| `image` | The active image generation connection |
| `tts` | The Voice & Speech TTS connection, else the default TTS profile |
| `stt` | The Voice & Speech STT connection (none until the user picks one) |
| `embedding` | The primary embedding connection |
| `decision` | The default Decision connection |

`getActive(kind)` resolves to `{ activeProfileId, provider, model }` for that
row. Pass a summary's `id` as `connectionId` to host APIs that accept one, for
example `ctx.stt.start({ provider: 'connection', connectionId })`.

## LLM profiles

| Method | Permission | Behavior |
| --- | --- | --- |
| `list()` | Free | LLM profile rows (synchronous; `api_key` removed) |
| `getActive()` | Free | `{ activeProfileId, provider, model }` of the active LLM profile (synchronous) |
| `subscribe(handler)` | Free | Calls `handler` when the active LLM profile changes; returns an unsubscribe function |
| `models(id)` | `generation` | Model list of an LLM profile |
| `setActive(id)` / `setActiveAcknowledged(id)` | `generation` | Switch the active LLM profile |
| `update(id, input)` | `generation` | Edit an LLM profile |
