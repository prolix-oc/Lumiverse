# Generation

!!! warning "Permission required: `generation`"

Fire LLM generations programmatically.

## `spindle.generate.raw(input)`

Direct generation — you specify the provider, model, and messages.

```ts
const result = await spindle.generate.raw({
  messages: [
    { role: 'user', content: 'Summarize this text: ...' },
  ],
  parameters: { temperature: 0.3, max_tokens: 200 },
  connection_id: 'optional-connection-id',
})
// result: { content: string, finish_reason: string, usage: { ... } }
```

## `spindle.generate.quiet(input)`

Uses the user's active connection profile and preset parameters.

```ts
const result = await spindle.generate.quiet({
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello!' },
  ],
})
```

## `spindle.generate.batch(input)`

Run multiple generation requests.

```ts
const results = await spindle.generate.batch({
  requests: [
    { messages: [...], provider: 'openai', model: 'gpt-4o' },
    { messages: [...], provider: 'openai', model: 'gpt-4o' },
  ],
  concurrent: true,
})
// results: Array<{ index, success, content?, error? }>
```

## GenerationRequestDTO

| Field | Type | Description |
|---|---|---|
| `messages` | `LlmMessageDTO[]` | The message array to send |
| `parameters` | `Record<string, unknown>` | Optional LLM parameters (temperature, max_tokens, etc.) |
| `connection_id` | `string` | Optional. Use a specific connection profile (see Connection Profiles below) |

---

## Connection Profiles

Extensions with the `generation` permission can discover and inspect the user's connection profiles. This lets you present a UI for selecting which LLM provider/model to use, or programmatically pick the right connection for your use case.

Connection profiles are returned as safe `ConnectionProfileDTO` objects — **API keys are never exposed** (only a `has_api_key` boolean).

### `spindle.connections.list(userId?)`

List all connection profiles available to the user.

```ts
const connections = await spindle.connections.list()
// connections: Array<{ id, name, provider, model, is_default, has_api_key, ... }>

const defaultConn = connections.find(c => c.is_default)
if (defaultConn) {
  const result = await spindle.generate.quiet({
    messages: [{ role: 'user', content: 'Hello' }],
    connection_id: defaultConn.id,
  })
}
```

### `spindle.connections.get(connectionId, userId?)`

Get a single connection profile by ID. Returns `null` if not found.

```ts
const conn = await spindle.connections.get('some-connection-id')
if (conn) {
  spindle.log.info(`Using ${conn.provider} / ${conn.model}`)
}
```

### ConnectionProfileDTO

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique connection profile ID |
| `name` | `string` | Human-readable display name |
| `provider` | `string` | LLM provider identifier (e.g. `"openai"`, `"anthropic"`) |
| `api_url` | `string` | Custom API URL (empty string for default) |
| `model` | `string` | Selected model identifier |
| `preset_id` | `string \| null` | Associated generation preset |
| `is_default` | `boolean` | Whether this is the user's default connection |
| `has_api_key` | `boolean` | Whether an API key is configured (key itself is never exposed) |
| `metadata` | `Record<string, unknown>` | Provider-specific metadata |
| `created_at` | `number` | Unix timestamp |
| `updated_at` | `number` | Unix timestamp |

!!! note
    For user-scoped extensions, the `userId` parameter is automatically inferred from the extension owner. For operator-scoped extensions, pass `userId` to scope the query to a specific user.
