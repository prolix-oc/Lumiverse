# Connection organization

Use `connections.organization` to read folders, connection order, and recent
selections for a connection picker. Reads are free and return no credentials or
endpoint URLs. Use `lumiverse-spindle-types` 0.6.75 or newer, and feature-detect
`connection-organization-v1` on older hosts.

```ts
const organization = ctx.connections.organization;
if ((ctx.host.capabilities['connection-organization-v1'] ?? 0) >= 1 && organization) {
  const stop = organization.watch({ kind: "llm" }, snapshot => {
    // Render snapshot.folders using snapshot.connections.
  }, error => console.error(error.code));
  // Call stop() when the view closes.
}
```

`get({ kind })` returns one snapshot. `watch({ kind }, handler, onError?)` delivers
the initial state and subsequent updates, and returns an unsubscribe function.

Supported kinds: `llm`, `image`, `tts`, `stt`, `embedding`, and `decision`.

Each snapshot contains:

- `kind` and `revision`, which can be compared to detect changes.
- `connections`: ordered summaries with ID, name, provider, model, active status,
  and TTS voice where applicable.
- `folders`: ordered groups with stable IDs, names, and ordered `connectionIds`.
  Empty folders are included. The Uncategorized group has `id: null` and
  `name: null`; supply its display label in your UI.
- `recentConnectionIds`: recent selections, newest first.

Backend calls use `spindle.connections.organization`. Operator-scoped extensions
must pass `{ kind, userId }`; user-scoped extensions use their owner.

Handle failures through `error.code`: `CONNECTION_KIND_INVALID`,
`USER_CONTEXT_REQUIRED`, `CONNECTION_WATCH_LIMIT`, or
`CONNECTION_ORGANIZATION_READ_FAILED`.
