# Event Tracking

!!! warning "Permission required: `event_tracking`"

A structured telemetry system for logging, debugging, and analytics within your extension. Events are persisted in the database with timestamps, severity levels, and optional chat association.

## Usage

```ts
// Track an event
await spindle.events.track('user_action', { action: 'clicked_button', value: 42 }, {
  level: 'info',
  chatId: 'optional-chat-id',
  retentionDays: 30,
})

// Query events with filters
const events = await spindle.events.query({
  eventName: 'user_action',
  since: '2024-01-01T00:00:00Z',
  level: 'info',
  limit: 100,
})
// [{ id, ts, eventName, level, chatId?, payload? }, ...]

// Replay events (same as query, for re-processing)
const replay = await spindle.events.replay({ chatId: 'some-chat-id' })

// Get latest state — extracts the most recent payload for each key
const state = await spindle.events.getLatestState(['player_score', 'current_scene'])
// { player_score: { score: 100 }, current_scene: { name: "forest" } }
```

## Methods

| Method | Returns | Description |
|---|---|---|
| `track(eventName, payload?, options?)` | `Promise<void>` | Log an event. Options: `{ level?, chatId?, retentionDays? }` |
| `query(filter?)` | `Promise<TrackedEvent[]>` | Query stored events with filters |
| `replay(filter?)` | `Promise<TrackedEvent[]>` | Replay events (same interface as query) |
| `getLatestState(keys)` | `Promise<Record<string, unknown>>` | Extract the latest payload for each named event key |

## Track Options

| Field | Type | Default | Description |
|---|---|---|---|
| `level` | `"debug" \| "info" \| "warn" \| "error"` | `"info"` | Severity level |
| `chatId` | `string` | — | Associate the event with a specific chat |
| `retentionDays` | `number` | — | How long to keep the event (server-enforced) |

## Query/Replay Filter

| Field | Type | Description |
|---|---|---|
| `eventName` | `string` | Filter by event name |
| `chatId` | `string` | Filter by chat ID |
| `since` | `string` | ISO 8601 start time |
| `until` | `string` | ISO 8601 end time |
| `level` | `"debug" \| "info" \| "warn" \| "error"` | Filter by severity |
| `limit` | `number` | Maximum number of results |

## TrackedEvent

```ts
{
  id: string
  ts: string              // ISO 8601
  eventName: string
  level: "debug" | "info" | "warn" | "error"
  chatId?: string
  payload?: Record<string, unknown>
}
```
