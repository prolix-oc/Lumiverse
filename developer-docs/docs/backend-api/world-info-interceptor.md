# World Info Interceptor

!!! warning "Permission required: `generation`"

World info interceptors run *before* world info activation. They receive the candidate entries plus the current chat state, and return a list of entry IDs to disable for this turn and/or per-entry content overrides.

```ts
spindle.registerWorldInfoInterceptor(async (ctx) => {
  const disabled: string[] = []
  for (const entry of ctx.entries) {
    if (entry.constant && ctx.chatTurn < 5) disabled.push(entry.id)
  }
  return { disabled }
}, 100)
```

Use this when an entry's stored fields can't express the activation rule (turn-based gates, sticky flags, external state lookups, content rewrites driven by retrieval).

## Parameters

| Param | Type | Description |
| --- | --- | --- |
| `handler` | `(ctx: WorldInfoInterceptorCtx) => Promise<WorldInfoInterceptorResult \| void>` | Returns disable + content-override decisions, or `void` to pass through |
| `priority` | `number` | Optional. Lower values run first. Default:`100` |

One interceptor per extension; a second registration replaces the first.

## Context Object

```ts
interface WorldInfoInterceptorCtx {
  chatId: string
  characterId: string
  userId?: string
  entries: WorldInfoInterceptorEntry[]
  messages: WorldInfoInterceptorMessage[]
  chatTurn: number
  chatMetadata: Record<string, unknown>
}

interface WorldInfoInterceptorEntry {
  id: string
  world_book_id: string
  comment: string
  disabled: boolean
  constant: boolean
  extensions: Record<string, unknown>
  key: string[]
  keysecondary: string[]
  position: number
  depth: number
  priority: number
  probability: number
  use_probability: boolean
  content: string
  automation_id: string | null
  selective: boolean
  selective_logic: number
  match_whole_words: boolean
  case_sensitive: boolean
  use_regex: boolean
  prevent_recursion: boolean
  exclude_recursion: boolean
  delay_until_recursion: boolean
  scan_depth: number | null
  order_value: number
}

interface WorldInfoInterceptorMessage {
  id: string
  role: "system" | "user" | "assistant"
  content: string
  is_user: boolean
  is_greeting: boolean
  greeting_index?: number
  swipe_id: number
  index_in_chat: number
}
```

`entries` reflects the current state of the chain: each interceptor sees the previous one's mutations. `disabled: true` on an incoming entry can mean either "stored as disabled" or "an earlier interceptor disabled it"; use `extensions` to mark your own provenance if you need to tell them apart.

`chatMetadata` is the chat-level metadata blob. Persist cross-turn state here via `spindle.chats.update`; the snapshot is read-only.

## Return Value

```ts
interface WorldInfoInterceptorResult {
  disabled?: string[]
  enabled?: string[]
  forced?: string[]
  mutated?: { id: string; content?: string }[]
}
```

Return `void` (or omit all arrays) for a no-op pass-through. The four axes are independent:

| Field | Effect |
| --- | --- |
| `disabled` | Forces `disabled: true`. Wins against any `enabled`/`forced` vote anywhere in the chain. |
| `enabled` | Un-flips a stored `disabled: true`. No effect on entries already enabled or on entries any handler voted to disable. |
| `forced` | Sets `constant: true` for this turn (activates regardless of key match). No effect if any handler voted to disable. Independent of `enabled`. To force a stored-disabled entry, vote both `enabled` and `forced`. |
| `mutated` | Replaces `content` for this turn only; the stored entry is unchanged. Applies regardless of activation state. |

Mutating an entry that another interceptor disabled is allowed but inert.

## Composition Order

Multiple interceptors run in priority order (lower first), with registration order as the tie-breaker. Each interceptor receives the previous one's mutations applied to the entry list. There is no cap on chain depth.

Vote-off precedence is the chain's invariant: once any handler votes `disabled` for an entry, no later handler's `enabled` or `forced` can revive it. This makes per-handler reasoning order-independent on the disable axis.

Content overrides accumulate last-write-wins: if two handlers set `content` for the same entry, the higher-priority handler (later in the chain) wins.

## Permission Scope

`registerWorldInfoInterceptor` requires the `generation` permission — the same gate that covers `registerInterceptor` and `registerContextHandler`. No additional permission is needed for content overrides.

## Timeout

Each interceptor runs inside a 10-second wall-clock budget. On timeout or thrown error: the chain logs the failure and forwards the previous entry list to the next handler. World info activation itself never aborts.

!!! warning "Users notice the wait"
    The interceptor fires before activation, which fires before prompt assembly, which fires before the LLM call. Slow handlers add visible latency before the first streamed token.

## World Info Interceptor vs Context Handler vs Interceptor

| Hook | When it fires | What it changes |
| --- | --- | --- |
| **World Info Interceptor** | Before world info activation | Per-entry disable + content overrides |
| [Context Handler](context-handlers.md) | Before prompt assembly | The generation context |
| [Interceptor](interceptors.md) | After assembly, before LLM call | The outgoing message array |
