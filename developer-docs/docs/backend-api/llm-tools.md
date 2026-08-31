# LLM Tools

!!! warning "Permission required: `tools`"

Register tools (function calling) that LLM providers can invoke during generation. Tools can also be made available as **Council tools**, allowing users to assign them to Council members for pre-generation analysis.

## Registering a Tool

```ts
spindle.registerTool({
  name: 'search_knowledge_base',
  display_name: 'Search Knowledge Base',
  description: 'Searches the extension knowledge base for relevant information',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', description: 'Max results', default: 5 },
    },
    required: ['query'],
  },
  council_eligible: true,
})

// Unregister
spindle.unregisterTool('search_knowledge_base')
```

## ToolRegistrationDTO

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Unique tool identifier (bare name — no colons) |
| `display_name` | `string` | Human-readable name shown in the Council tools list |
| `description` | `string` | Description for the LLM. Used in function calling and as the tool prompt for Council sidecar mode |
| `parameters` | `JSONSchema` | JSON Schema defining the tool's input arguments |
| `council_eligible` | `boolean` | Optional. When `true`, the tool appears in the Council tools list and can be assigned to Council members. Default: `false` |

The `extension_id` field is set automatically by the host — you don't need to provide it.

## Preset-owned Agents & Tools

The preset **Agents & Tools** feature is separate from this extension registration API and from Council. It uses a host-owned, fixed catalog; extensions cannot register, replace, or execute a tool in that catalog, and `spindle.registerTool()` tools do not become child-profile tools.

Core-tool authorization comes from the preset's `agentConfig` and the host's local user context; it is not an extension `tools` grant and does not require an extension registration.

When an enabled preset grants tools, the main model may receive these six read-only core tools:

| Tool | Arguments |
|---|---|
| `lore_list_books` | Optional `scope`, `folder`, `query`, `limit`, `offset`, `format` |
| `lore_get_book` | Exactly one of `book_id` or `book_name`; optional `scope`, `limit`, `offset`, `format` |
| `lore_list_entries` | Exactly one of `book_id` or `book_name`; optional `scope`, `limit`, `offset`, `format` |
| `lore_get_entry` | Required `entry_id`; optional `scope`, `format` |
| `lore_search_entries` | Required `query`; optional `book_id` or `book_name`, `scope`, `limit`, `offset`, `format` |
| `chat_search_history` | Required `query`; optional `role`, `limit`, `offset`, `format` |

`agent_delegate` is an additional main-model-only tool. Its arguments are `profile_id`, a `task` of at most 32 KiB UTF-8, and optional narrowing `tool_ids`; only profiles whose local author enabled `allowMainDelegation` are addressable, and the tool has no model-controlled stream argument. A child is depth-one: it may use its authorized lore/chat tools but never receives `agent_delegate`.

All feature definitions use strict JSON Schema (`additionalProperties: false`) and matching runtime parsers. Selectors are at most 512 characters; `limit` is 1–50 and `offset` is a non-negative integer. `scope` defaults to `active` and cannot exceed the server-held grant. `format` is `json` or `text`. Results use a stable `{ data, total, limit, offset, truncated }` envelope (or text carrying the same IDs, provenance, and continuation values). `lore_get_book` is paged, so a whole book is read through bounded continuation rather than one unbounded response. An ambiguous book name returns candidate IDs and requires an ID retry.

### Scope and snapshot boundaries

Each child profile and the main model has an independent tool allowlist and lore-scope ceiling. A call may narrow that grant but never widen it. `active` is the immutable full enabled lore corpus considered by the current generation after World Info interception, with finalized overlays and book/source provenance; an entry can remain in this corpus with `activated: false`, because `activated` independently reports whether that entry was selected for prompt injection. `all_owned` is an explicit local grant for bounded live FTS/LIKE lookups under the root user's ownership. Disabled entries are excluded in both scopes.
`lore_search_entries` ranks exact, then prefix, then substring matches in comment/title and primary keys before secondary keys and content-only matches. Active results preserve snapshot order for equal relevance; owned results use stable book/order/id ties. Ranking is applied before `offset` and `limit`, while `total` and `truncated` describe the full matching set.

`chat_search_history` reads one immutable projection of the exact message snapshot already selected for the generation: active-swipe role/name/index/content in chat order. It excludes hidden and `_loom_inject` rows, the regenerate/swipe exclusion target, staged or pending targets, inactive swipes, attachments, extras, unrelated internal IDs, and every other chat. The model cannot supply a user ID, chat ID, ownership, or broader scope.

Tool results are host-framed lower-authority derived data. They do not expose credentials, exception stacks, arbitrary metadata bags, hidden messages, disabled lore, or raw user IDs beyond documented IDs. In `text` format, rendering uses only a fresh minimal context and the no-argument display-name/group macros `user`, `char`, `group`, `groupNotMuted`, `notChar`, `isGroupChat`, `groupOthers`, and `groupMemberCount` (and their built-in aliases); disallowed macro syntax remains literal and does not receive the full macro environment.

This catalog is not Council. Council still uses registered tools and its configured sidecar/inline behavior described below. The Agents & Tools feature does not discover extension tools or invoke extension workers. Live activity stays status-only. Authenticated owner inspection preserves its existing bounded provider exchanges, tool calls/results, accounting, accepted workspace evidence, receipts, IDs, and handoff guidance under retention/omission limits. Prior-segment prose/messages and tool calls/results are retired only from the next segment's provider context and are never replayed as continuity; raw hidden reasoning and opaque continuation carriers are prohibited. A real staged/target assistant message may retain a compact swipe-scoped summary.

### Runtime activity and privacy

The host-owned catalog runs inside the same root ledger as the provider loop. A call batch is validated before any side effect, executed serially in provider order, and returned with one bounded correlated result per call before continuation. When the authored aggregate-call or host request budget is exhausted, the host performs one tools-disabled finalization request; it does not silently persist pending calls.

`GENERATION_AGENT_ACTIVITY` and terminal activity snapshots are status-only. They contain server-authored IDs, actor/kind, phase/status, allowlisted profile/tool identifiers, elapsed time, continuation mode, bounded counters/usage, and stable public error codes. They never contain task text, provider messages, model labels, arguments, result bodies, retrieved content, credentials, stacks, or reasoning carriers. Live snapshots and retained swipe/fallback summaries are bounded and evict detail deterministically while preserving aggregate counts. See [Generation](generation.md#preset-owned-agents--tools-during-generation) for effective host ceilings, environment settings, and recovery behavior.

Provider dispatches use `GenerationRequest.toolMode` with `ordinary`,
`required`, or `finalization`. `required` is provider-neutral: it requires some
admitted host tool and never selects a named tool. The frozen provider must
positively declare `ProviderCapabilities.requiredToolChoice`; unknown and custom
providers default to false. Both orchestration and each provider serializer fail
closed before a request when that declaration or an admitted tool is absent.
OpenAI-compatible serializers emit `tool_choice: 'required'`, Anthropic emits
`{ type: 'any' }`, and Google/Vertex emit function-calling mode `ANY`.
`finalization` removes or explicitly disables every tool surface.

See [Generation](generation.md#preset-owned-agents--tools-during-generation) for provider continuation, runtime limits, cancellation, and Dry Run/multiplayer behavior, and [World Books](world-books.md#agents--tools-lore-boundary) for the frozen lore-corpus boundary.

## Council Tool Integration

When `council_eligible: true`, your tool appears in the user's Council panel alongside built-in tools. Users can assign it to any Council member. During generation, if the member is active (passes their dice roll), your tool is invoked.

### How tools are invoked

Tools execute differently depending on the Council **mode** (configured by the user):

| Mode | How your tool runs |
|---|---|
| **Sidecar** (default) | A separate sidecar LLM reads your tool's `description` as a prompt and generates a text response. Your extension is **not** called — sidecar tools use the LLM, not your code. |
| **Inline** | Your tool definition is sent as a function-call schema to the primary LLM. The LLM decides when to invoke it. |

!!! note "Extension tools always route to your worker"
    Unlike built-in/DLC tools (which are pure LLM prompts), **extension-registered tools** are always invoked via your worker — even in sidecar mode. The host sends a `tool_invocation` message to your worker with the chat context, and your code returns the result.

### Handling tool invocations

When your tool is invoked during Council execution, the host sends a `TOOL_INVOCATION` event to your worker:

```ts
spindle.on('TOOL_INVOCATION', async (payload) => {
  const { toolName, args, councilMember, contextMessages } = payload

  if (toolName === 'search_knowledge_base') {
    const results = await searchMyKnowledgeBase(args.query, args.limit)

    // Inspect the structured chat context if you need role boundaries
    const lastAssistant = contextMessages
      ?.filter(m => m.role === 'assistant')
      .pop()

    // When invoked via council, tailor the output to the assigned member's voice
    if (councilMember) {
      return `${councilMember.name} (${councilMember.role || 'analyst'}) reports:\n` +
        results.map(r => r.summary).join('\n')
    }

    return results.map(r => r.summary).join('\n')
  }

  return 'Unknown tool'
})
```

The return value is a string that becomes the tool's result in the Council deliberation block (visible to the main LLM during generation).

### Tool naming

Extension tools are stored internally with a qualified name: `extensionId:toolName`. When a user assigns your tool to a Council member, the qualified name is used. You don't need to worry about collisions with other extensions' tools.

### Invocation payload

The handler receives a `ToolInvocationPayloadDTO`:

| Field | Type | Description |
|---|---|---|
| `toolName` | `string` | The bare name you registered (no `extensionId:` qualifier) |
| `args` | `Record<string, unknown>` | Arguments matching your tool's `parameters` schema, plus the host-supplied fields below |
| `requestId` | `string` | Host-side correlation id for this invocation |
| `councilMember` | `CouncilMemberContext \| undefined` | Assigned member snapshot when invoked via council — see below. Undefined for non-council invocation paths |
| `contextMessages` | `LlmMessageDTO[] \| undefined` | Structured chat context for council invocations — the same content as the flattened `args.context` string, but with role boundaries preserved. See below. Undefined for non-council invocation paths |

Host-supplied fields inside `args` for council invocations:

| Field | Type | Description |
|---|---|---|
| `context` | `string` | Formatted chat context (character info, world info, recent messages) — the same context sidecar tools see. Kept for backwards compatibility; use `contextMessages` (top-level) when you need role boundaries |
| `__deadlineMs` | `number` | Timestamp by which the tool must respond (derived from `timeoutMs` setting) |

!!! note "No `__userId` in args"
    The worker host strips `__userId`, `__user_id`, and `userId` from `args` before delivering the invocation. Extensions identify their owner via their worker context, not a string parameter. Any userId you receive in `args` would be untrusted; don't rely on one being present.

### Council member context

When a tool is invoked as part of a council cycle, the host attaches a `councilMember` snapshot of the assigned member. Use it to personalise your tool's response in the member's voice, filter by role, or surface the avatar in modal UI.

```ts
interface CouncilMemberContext {
  memberId: string              // Council settings row id
  itemId: string                // Backing Lumia item id
  packId: string                // Pack the item lives in
  packName: string              // Pack display name
  name: string                  // Member / Lumia item name
  role: string                  // User-assigned role (e.g. "Plot Enforcer")
  chance: number                // Participation probability 0–100
  avatarUrl: string | null      // Relative URL (e.g. /api/v1/images/{id})
  definition: string            // Lumia "definition" field
  personality: string           // Lumia "personality" field
  behavior: string              // Lumia "behavior" field
  genderIdentity: 0 | 1 | 2 | 3 // 0=feminine, 1=masculine, 2=neutral, 3=any
}
```

The context is built entirely host-side from the user's council settings row and the backing Lumia item. It is delivered as a separate top-level field on the payload so user-space `args` cannot collide with or spoof it. `councilMember` is `undefined` for any non-council invocation path (future inline function calling, etc.) — guard on presence before reading.

### Structured context messages

Council invocations also deliver the assembled chat context as a structured `contextMessages: LlmMessageDTO[]` field. This is the same content that populates `args.context` (kept for backwards compatibility), but with role boundaries preserved so you can filter by role, extract the last user/assistant turn, or re-render the context in your own format.

```ts
interface LlmMessageDTO {
  role: 'system' | 'user' | 'assistant'
  content: string | LlmMessagePartDTO[]
  name?: string
}
```

Multi-part content (text, image, audio, `tool_use`, `tool_result`) is flattened to its text portion before being forwarded to Council tool handlers — non-text parts are dropped here. See [Interceptors › LlmMessageDTO](interceptors.md#llmmessagedto) for the full part union, and [Generation › Tool calling](generation.md#tool-calling) for the wire shapes per provider.

Like `councilMember`, `contextMessages` is delivered as a separate top-level payload field so it cannot collide with or be spoofed by user-space `args`. It is `undefined` for any non-council invocation path — guard on presence before reading.

### Tool lifecycle

- Tools are registered when your extension loads (`spindle.registerTool()`)
- Tools are automatically unregistered when your extension stops or unloads
- If the `tools` permission is revoked, registration silently fails and a `permission_denied` event fires

## Sidecar LLM

Council tools, expression detection, and other background LLM features share a **sidecar LLM connection** configured by the user in the Council panel under "Sidecar LLM". This is independent of the user's main generation connection.

The sidecar connection is stored as the `sidecarSettings` user setting:

```ts
interface SidecarConfig {
  connectionProfileId: string  // FK to a connection profile
  model: string                // Model override
  temperature: number          // Default: 0.7
  topP: number                 // Default: 0.9
  maxTokens: number            // Default: 1024
}
```

Your extension doesn't need to interact with sidecar settings directly — tool invocations are routed through the host, which handles connection resolution. If you need to fire your own LLM calls, use `spindle.generate.quiet()` or `spindle.generate.raw()` with the `generation` permission instead.
