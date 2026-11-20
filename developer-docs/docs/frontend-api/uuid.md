# UUIDs

`ctx.uuid` generates UUID strings synchronously using Lumiverse's existing frontend UUID helper. It needs no permission, backend module, or network request.

`crypto.randomUUID()` is unavailable in insecure browser contexts, such as a Lumiverse instance opened over plain HTTP on a remote host. This helper uses `crypto.getRandomValues()`, which is available in those contexts.

`frontend-uuid-v1` advertises this frontend API. The backend capability `uuid-v1` does not imply that `ctx.uuid` exists. Feature-detect both the frontend capability and the member when supporting older hosts:

```ts
import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

export function setup(ctx: SpindleFrontendContext) {
  if (!ctx.uuid || (ctx.host.capabilities['frontend-uuid-v1'] ?? 0) < 1) {
    throw new Error('This extension requires frontend-uuid-v1. Update Lumiverse.')
  }

  const randomId = ctx.uuid.v4()
  const orderedId = ctx.uuid.v7()
  // Both values are strings immediately; no await is needed.
}
```

| Method | Returns | Description |
|--------|---------|-------------|
| `v4()` | `string` | Random UUID with 122 random bits |
| `v7()` | `string` | Timestamp-ordered UUID using the frontend clock and shared helper counter |

Both methods return lowercase UUID strings in `8-4-4-4-12` hexadecimal format. Existing stored IDs do not need to change. Calls throw for an inactive or unloaded frontend context, including captured method references.

Frontend v7 calls share the core helper's counter within the same frontend runtime. They do not share the backend counter or establish ordering across browser tabs, devices, or server processes. Use [the backend UUID API](../backend-api/uuid.md) when generation should belong to the backend; its methods return `Promise<string>`.
