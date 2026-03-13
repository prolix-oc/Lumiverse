# Permissions

Extensions have two tiers of capabilities.

## Free Tier (no declaration needed)

These are always available:

- **Events** — subscribe to any Lumiverse event
- **Storage** — read/write to your extension's scoped storage directory
- **User Storage** — per-user isolated storage, even for operator-scoped (globally installed) extensions
- **Secure Enclave** — encrypted at-rest secret storage (AES-256-GCM), per-user isolated
- **Macros** — register custom `{{macros}}` for use in prompts
- **DOM** — inject sanitized HTML and CSS via the frontend DOM helper
- **Drawer Tabs** — register tabs in the ViewportDrawer sidebar
- **Input Bar Actions** — register actions in the chat input bar Extras popover
- **Logging** — write to the server console
- **Frontend <-> Backend messaging** — relay messages between your modules

## Gated Tier (must declare in `permissions` and be granted by the user)

| Permission | Description |
|---|---|
| `"generation"` | Fire LLM generations (raw, quiet, batch) on behalf of the user. Also grants access to list/inspect connection profiles. |
| `"interceptor"` | Register a pre-generation interceptor that can modify the prompt before it reaches the LLM |
| `"tools"` | Register LLM tools (function calling) |
| `"cors_proxy"` | Make HTTP requests through the Lumiverse server (bypass CORS) |
| `"context_handler"` | Register middleware that enriches the generation context before prompt assembly |
| `"ephemeral_storage"` | Use temporary storage with TTL, memory pooling, and per-extension quotas |
| `"chat_mutation"` | Read and modify chat messages (append, update, delete) |
| `"event_tracking"` | Track, query, and replay extension-level telemetry events |
| `"ui_panels"` | Create floating widgets and docked edge panels that overlay/consume screen space |
| `"app_manipulation"` | Mount unrestricted portals into the document body that persist across routes |
| `"oauth"` | Register an OAuth callback handler to receive authorization redirects from external services |

Users grant permissions individually from the Extensions panel. Your extension should degrade gracefully if a permission isn't granted.

## Handling Permission Denials

All permission-gated operations return structured errors when the required permission has not been granted.

### Request/Response Operations

For generation, connections, CORS, chat, events, and ephemeral storage, the returned error string is prefixed with `PERMISSION_DENIED:` followed by the permission name:

```ts
try {
  await spindle.generate.quiet({ messages: [...] })
} catch (err) {
  if (err.message.startsWith('PERMISSION_DENIED:')) {
    spindle.log.warn('Generation permission not granted — feature disabled')
  } else {
    spindle.log.error(`Generation failed: ${err.message}`)
  }
}
```

### Fire-and-Forget Registrations

For interceptors, tools, and context handlers, the host sends a `permission_denied` notification. Listen for these via `spindle.permissions.onDenied()`:

```ts
spindle.permissions.onDenied(({ permission, operation }) => {
  spindle.log.warn(`Permission "${permission}" denied for ${operation}`)
})

// This registration will silently no-op if "interceptor" isn't granted,
// but your onDenied handler will fire with the details.
spindle.registerInterceptor(async (messages, ctx) => { ... })
```

### Checking Permissions Upfront

You can also check permissions upfront to avoid the denial entirely:

```ts
const granted = await spindle.permissions.getGranted()
if (granted.includes('generation')) {
  // Safe to use spindle.generate.* and spindle.connections.*
}
```
