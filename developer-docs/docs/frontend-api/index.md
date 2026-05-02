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

## API Surface

Frontend UI can follow two supported rendering paths:

- direct host rendering through `ctx.dom.*` and `ctx.ui.*`
- isolated iframe rendering through `ctx.dom.createSandboxFrame(...)` and `ctx.messages.renderWidget(...)`

| Category | Permission | Description |
|----------|-----------|-------------|
| [DOM Helper](dom-helper.md) | Free | Inject sanitized HTML/CSS in the host DOM and create host-managed sandbox frames |
| [UI Event Helpers](ui-events-helper.md) | Free | Keyboard/Drawer/Settings state and DOM Action delegation |
| [HTML Islands](html-islands.md) | Free | Auto-isolation of styled HTML in messages, and how to opt out |
| [Events](events.md) | Free | Subscribe to WebSocket events, emit custom events |
| [UI Placement](ui-placement.md) | Varies | Drawer tabs, float widgets, dock panels, modals, context menus, input bar actions |
| [Backend Communication](backend-communication.md) | Free | Send/receive messages to/from backend worker |
| [Frontend Process Lifecycle](processes.md) | Free | Register backend-spawned frontend process handlers |
| [Message Tags](message-tags.md) | Free | Intercept custom XML tags in chat messages |
| [File Uploads](file-uploads.md) | Free | Open file picker and read selected files |
