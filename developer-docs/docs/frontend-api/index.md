# Frontend API

Your frontend module must export a `setup(ctx)` function. It receives a `SpindleFrontendContext` for host DOM rendering, events, backend communication, and opt-in sandbox frames.

```ts
import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

export function setup(ctx: SpindleFrontendContext) {
  // Your initialization code here

  // Return a cleanup function (optional)
  return () => {
    ctx.dom.cleanup()
  }
}
```

Alternatively, export a `teardown()` function:

```ts
export function setup(ctx: SpindleFrontendContext) {
  // init
}

export function teardown() {
  // cleanup
}
```

## Host compatibility and startup

The backend worker and frontend module receive the same immutable host contract for their side of the runtime. Backend code reads `spindle.host`; frontend code reads `ctx.host`:

```ts
export function setup(ctx: SpindleFrontendContext) {
  const finalResponseVersion = ctx.host.capabilities['interceptor-final-response-v1']
  if (finalResponseVersion === 1) {
    // The host supports the versioned final-response contract.
  }
}
```

`SpindleHostDescriptorV1` has this shape:

| Field | Type | Meaning |
|---|---|---|
| `descriptorVersion` | `1` | Version of the descriptor shape |
| `lumiverseVersion` | `string` | Canonical Lumiverse application version for this host side |
| `capabilities` | `Readonly<Record<string, number>>` | Versioned host capability map |
| `extensionInstallationId` | `string` | Host-assigned canonical lowercase UUID for this installed extension instance |

The descriptor and its nested capability map are immutable frozen snapshots. The installation ID is host-owned, is not an extension-provided identity, and is bound to the installed extension instance. The current guaranteed capability entries are:

- `preset-extension-data-v1: 1`
- `preset-editor-v1: 1`
- `loom-block-editor-v1: 1`
- `loom-block-management-v1: 1`
- `generation-assembly-v1: 1`
- `interceptor-context-v1: 1`
- `interceptor-final-response-v1: 1`
- `connection-dispatch-resolution-v1: 1`

Hosts may add valid capability keys in future versions. Ignore unknown keys and check the known capability name and version your extension requires; do not treat an unknown key as a compatibility failure.

The optional `minimum_lumiverse_version` manifest field is compared with this host application version during compatibility checks; see [Manifest → Fields](../getting-started/manifest.md#fields) for the enforcement points and fail-closed behavior.

The descriptor is available synchronously: `spindle.host` is present before backend entry code runs, and `ctx.host` is present before `setup(ctx)` runs. Do not mutate either value. Before the frontend bundle is fetched or extension setup/mount is allowed, the host performs one bounded compatibility handshake. The frontend sends a host-generated ephemeral nonce; the backend echoes it and returns the descriptor plus a deterministic SHA-256 digest of its canonical serialization. The digest covers the remaining descriptor fields, including the descriptor version, Lumiverse application version, named capability versions, and installation ID. Any nonce mismatch, malformed descriptor, required-capability mismatch, application-version mismatch, installation-ID mismatch, or digest mismatch returns the structured `SPINDLE_COMPATIBILITY_ERROR` failure and no extension code is evaluated or mounted.

`setup(ctx)` supports synchronous and asynchronous initialization. It may return a cleanup function directly or a `Promise` resolving to one; the host awaits setup before the load operation completes. On unload, the host invokes the returned cleanup or exported `teardown()` at most once and awaits an asynchronous teardown before unload completes. Without `ctx.deferReady()`, the host auto-readies only after setup settles successfully. Calling `ctx.deferReady()` during setup keeps startup messages queued until the extension calls the idempotent `ctx.ready()`; that call may release the queue before an asynchronous setup promise settles once its handlers are safe. The bounded readiness deadline is 10 seconds; a timeout rejects the load, discards queued startup messages, and unloads the extension instead of auto-recovering. Setup rejection likewise tears down the extension.
`ctx.locale` provides synchronous host-locale access through `ctx.locale.get()` and an idempotent `ctx.locale.subscribe(listener)` change subscription. The host locale is one of `en`, `zh`, `zh-TW`, `ja`, `fr`, or `it`; subscriptions are removed with the extension during teardown.

For the detailed message-queue rules and readiness example, see [Frontend-to-Backend Communication → Startup readiness](backend-communication.md#startup-readiness).

For the privileged final-response contract, see [Interceptors → Authoritative final response](../backend-api/interceptors.md#authoritative-final-response).

## API Surface

Frontend UI can follow two supported rendering paths:

- direct host rendering through `ctx.dom.*` and `ctx.ui.*`
- isolated iframe rendering through `ctx.dom.createSandboxFrame(...)` and `ctx.messages.renderWidget(...)`

| Category | Permission | Description |
|----------|-----------|-------------|
| [DOM Helper](dom-helper.md) | Free | Inject sanitized HTML/CSS in the host DOM, target specific chat messages with virtualizer-safe replay, and create host-managed sandbox frames |
| [UI Event Helpers](ui-events-helper.md) | Free | Keyboard/Drawer/Settings state and DOM Action delegation |
| [HTML Islands](html-islands.md) | Free | Auto-isolation of styled HTML in messages, and how to opt out |
| [Events](events.md) | Free | Subscribe to WebSocket events, emit custom events |
| [UI Placement](ui-placement.md) | Varies | Drawer tabs, float widgets, dock panels, modals, context menus, input bar actions |
| [Shared Components](shared-components.md) | Free | Mount Lumiverse's first-party React components — model picker, form atoms, searchable selects, pagination, and the native Loom block editor — into extension-owned DOM |
| [Backend Communication](backend-communication.md) | Free | Send/receive messages to/from backend worker |
| [Frontend Process Lifecycle](processes.md) | Free | Register backend-spawned frontend process handlers |
| [Message Tags](message-tags.md) | Free | Intercept custom XML tags in chat messages |
| [Display Resolver](display-resolver.md) | Free | Resolve message display (macros, format, regex) in the browser for chats your extension owns |
| [File Uploads](file-uploads.md) | Free | Open file picker and read selected files |
