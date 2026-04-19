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
  genderIdentity: 0 | 1 | 2     // 0=unspecified, 1=feminine, 2=masculine
}
```

The context is built entirely host-side from the user's council settings row and the backing Lumia item. It is delivered as a separate top-level field on the payload so user-space `args` cannot collide with or spoof it. `councilMember` is `undefined` for any non-council invocation path (future inline function calling, etc.) — guard on presence before reading.

### Structured context messages

Council invocations also deliver the assembled chat context as a structured `contextMessages: LlmMessageDTO[]` field. This is the same content that populates `args.context` (kept for backwards compatibility), but with role boundaries preserved so you can filter by role, extract the last user/assistant turn, or re-render the context in your own format.

```ts
interface LlmMessageDTO {
  role: 'system' | 'user' | 'assistant'
  content: string
  name?: string
}
```

Multi-part message content (multimodal text+image/audio parts) is flattened to its text portion before being forwarded — non-text parts are dropped.

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
