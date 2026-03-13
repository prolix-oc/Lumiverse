# Frontend API

Your frontend module must export a `setup(ctx)` function. It receives a `SpindleFrontendContext` with sandboxed access to the DOM, events, and backend communication.

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

| Category | Permission | Description |
|----------|-----------|-------------|
| [DOM Helper](dom-helper.md) | Free | Inject sanitized HTML and CSS |
| [Events](events.md) | Free | Subscribe to WebSocket events, emit custom events |
| [UI Placement](ui-placement.md) | Varies | Drawer tabs, float widgets, dock panels, input bar actions |
| [Backend Communication](backend-communication.md) | Free | Send/receive messages to/from backend worker |
| [Message Tags](message-tags.md) | Free | Intercept custom XML tags in chat messages |
| [File Uploads](file-uploads.md) | Free | Open file picker and read selected files |
