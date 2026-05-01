# Permissions

Extensions have two tiers of capabilities.

## Free Tier (no declaration needed)

These are always available:

- **Events** — subscribe to any Lumiverse event
- **Storage** — read/write to your extension's scoped storage directory
- **Shared RPC Pool** — publish and read cross-extension latest-state endpoints
- **User Storage** — per-user isolated storage, even for operator-scoped (globally installed) extensions
- **Secure Enclave** — encrypted at-rest secret storage (AES-256-GCM), per-user isolated
- **Macros** — register custom `{{macros}}` for use in prompts
- **DOM** — inject sanitized HTML and CSS via the frontend DOM helper
- **Drawer Tabs** — register tabs in the ViewportDrawer sidebar
- **Input Bar Actions** — register actions in the chat input bar Extras popover
- **Variables** — read/write local (chat-scoped) and global (cross-chat) variables
- **Logging** — write to the server console
- **Toast Notifications** — show success/warning/error/info toasts in the frontend UI
- **Frontend <-> Backend messaging** — relay messages between your modules

## Gated Tier (must declare in `permissions` and be granted by the user)

| Permission | Description |
|---|---|
| `"generation"` | Fire LLM generations (raw, quiet, batch) on behalf of the user. Also grants access to list/inspect connection profiles. |
| `"interceptor"` | Register a pre-generation interceptor that can modify the prompt before it reaches the LLM |
| `"tools"` | Register LLM tools (function calling). Council-eligible tools appear in the Council tools list and can be assigned to members for pre-generation analysis |
| `"cors_proxy"` | Make HTTP requests through the Lumiverse server (bypass CORS) |
| `"context_handler"` | Register middleware that enriches the generation context before prompt assembly |
| `"generation_parameters"` | Inject provider-specific parameters (e.g. `response_format`, sampling overrides) into in-flight generations via interceptors. Requires `interceptor` to be useful |
| `"ephemeral_storage"` | Use temporary storage with TTL, memory pooling, and per-extension quotas |
| `"characters"` | Full CRUD on character cards (list, get, create, update, delete) |
| `"chats"` | CRUD on chat sessions (list, get, update, delete) + get active chat |
| `"world_books"` | Full CRUD on world books and their entries (list, get, create, update, delete) |
| `"databanks"` | Full CRUD on databanks and their documents (list, get, create, update, delete, reprocess, read parsed content) |
| `"personas"` | Full CRUD on personas (list, get, create, update, delete) + active switching + attached world book retrieval |
| `"chat_mutation"` | Read and modify chat messages (append, update, delete) |
| `"event_tracking"` | Track, query, and replay extension-level telemetry events |
| `"ui_panels"` | Create floating widgets and docked edge panels that overlay/consume screen space |
| `"app_manipulation"` | Mount unrestricted portals into the document body that persist across routes. Also grants access to the Theme API for applying CSS variable overrides on top of the user's theme |
| `"oauth"` | Register an OAuth callback handler to receive authorization redirects from external services |
| `"push_notification"` | Send OS-level push notifications to users' devices even when the app is closed or backgrounded |
| `"image_gen"` | Generate images via image gen connection profiles. Also grants access to list providers, connections, and models |

Users grant permissions individually from the Extensions panel. Your extension should degrade gracefully if a permission isn't granted.

## Live Permission Updates

Permission changes take effect **immediately** — the extension does not restart when a user grants or revokes a permission. This means:

- The host enforces permissions on every API call in real time. A revoked permission blocks the very next request.
- Your extension receives a `permission_changed` notification so it can react instantly (enable/disable features, update UI, re-register tools, etc.).
- The local permission cache (`spindle.permissions.has()`) is kept in sync automatically.

This makes permission management fast and seamless for users. Your extension should be designed to activate and deactivate features on the fly.

## Checking Permissions

### Synchronous Check (recommended)

Use `spindle.permissions.has()` for instant, zero-cost permission checks. It reads from a local cache that is seeded on startup and kept in sync by `permission_changed` messages:

```ts
if (spindle.permissions.has('generation')) {
  // Safe to use spindle.generate.* and spindle.connections.*
  await initGenerationFeatures()
}
```

This is ideal for gating features at startup or inside event handlers.

### Async Check

Use `spindle.permissions.getGranted()` to fetch the full list of granted permissions from the host. This performs an RPC roundtrip but is guaranteed to be authoritative:

```ts
const granted = await spindle.permissions.getGranted()
if (granted.includes('generation')) {
  // ...
}
```

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

## Reacting to Permission Changes

Use `spindle.permissions.onChanged()` to respond when a user grants or revokes a permission at runtime. This is the core mechanism for building extensions that activate features on the fly:

```ts
spindle.permissions.onChanged(({ permission, granted, allGranted }) => {
  if (permission === 'generation') {
    if (granted) {
      spindle.log.info('Generation permission granted — enabling features')
      startGenerationFeatures()
    } else {
      spindle.log.info('Generation permission revoked — disabling features')
      stopGenerationFeatures()
    }
  }
})
```

The handler receives a `PermissionChangedDetail` object:

| Field | Type | Description |
|---|---|---|
| `permission` | `string` | The permission that changed |
| `granted` | `boolean` | `true` if granted, `false` if revoked |
| `allGranted` | `string[]` | Full list of currently granted permissions after the change |

You can also listen for the `PERMISSION_CHANGED` event via `spindle.on()`:

```ts
spindle.on('PERMISSION_CHANGED', (detail) => {
  // detail has the same shape as PermissionChangedDetail
})
```

## Patterns

### Gate Features at Startup, Activate on Grant

The recommended pattern is to check permissions at startup, then listen for changes:

```ts
// ── Startup ──
if (spindle.permissions.has('generation')) {
  startGenerationFeatures()
}

if (spindle.permissions.has('tools')) {
  registerAllTools()
}

// ── React to live changes ──
spindle.permissions.onChanged(({ permission, granted }) => {
  switch (permission) {
    case 'generation':
      granted ? startGenerationFeatures() : stopGenerationFeatures()
      break
    case 'tools':
      granted ? registerAllTools() : unregisterAllTools()
      break
  }
})
```

### Deferred Registration

If your extension's core feature requires a gated permission, you can defer registration until the permission is granted:

```ts
let interceptorRegistered = false

function tryRegisterInterceptor() {
  if (interceptorRegistered) return
  if (!spindle.permissions.has('interceptor')) return

  spindle.registerInterceptor(async (messages, ctx) => {
    // Modify the prompt...
    return messages
  })
  interceptorRegistered = true
  spindle.log.info('Interceptor registered')
}

// Try immediately
tryRegisterInterceptor()

// Also try whenever permissions change
spindle.permissions.onChanged(({ permission, granted }) => {
  if (permission === 'interceptor' && granted) {
    tryRegisterInterceptor()
  }
})
```

### Graceful Degradation with User Feedback

Show the user what's missing using toast notifications:

```ts
async function generateSummary(chatId: string) {
  if (!spindle.permissions.has('generation')) {
    spindle.toast.warning(
      'Enable the "Generation" permission in the Extensions panel to use this feature.'
    )
    return null
  }

  const result = await spindle.generate.quiet({
    messages: [{ role: 'user', content: 'Summarize this conversation.' }],
  })
  return result
}
```
