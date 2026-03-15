# Full-Stack Extension (Backend + Frontend)

An external API bridge that fetches data through the CORS proxy and displays results in the UI.

## `spindle.json`

```json
{
  "version": "1.0.0",
  "name": "External API Bridge",
  "identifier": "api_bridge",
  "author": "Dev",
  "github": "https://github.com/dev/api-bridge",
  "homepage": "https://github.com/dev/api-bridge",
  "permissions": ["cors_proxy", "generation"],
  "entry_backend": "dist/backend.js",
  "entry_frontend": "dist/frontend.js"
}
```

## `src/backend.ts`

```ts
declare const spindle: import('lumiverse-spindle-types').SpindleAPI

spindle.onFrontendMessage(async (payload: any) => {
  if (payload.type === 'fetch_external') {
    try {
      const result = await spindle.cors(payload.url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      })
      spindle.sendToFrontend({
        type: 'external_result',
        requestId: payload.requestId,
        data: result,
      })
    } catch (err: any) {
      spindle.sendToFrontend({
        type: 'external_error',
        requestId: payload.requestId,
        error: err.message,
      })
    }
  }
})

spindle.log.info('API Bridge loaded!')
```

## `src/frontend.ts`

```ts
import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

export function setup(ctx: SpindleFrontendContext) {
  const removeStyle = ctx.dom.addStyle(`
    .api-bridge-panel {
      padding: 12px;
      background: var(--lumiverse-fill-subtle);
      border-radius: var(--lumiverse-radius);
      margin: 8px;
    }
    .api-bridge-panel input {
      width: 100%;
      padding: 6px 10px;
      background: var(--lumiverse-fill);
      border: 1px solid var(--lumiverse-border);
      border-radius: var(--lumiverse-radius);
      color: var(--lumiverse-text);
      margin-bottom: 8px;
    }
    .api-bridge-result {
      font-size: 12px;
      color: var(--lumiverse-text-muted);
      white-space: pre-wrap;
      max-height: 200px;
      overflow-y: auto;
    }
  `)

  ctx.dom.inject('body', `
    <div class="api-bridge-panel">
      <input class="api-bridge-input" placeholder="Enter URL to fetch..." />
      <div class="api-bridge-result">Results appear here</div>
    </div>
  `)

  const input = ctx.dom.query('.api-bridge-input') as HTMLInputElement
  const result = ctx.dom.query('.api-bridge-result')

  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        ctx.sendToBackend({
          type: 'fetch_external',
          url: input.value.trim(),
          requestId: crypto.randomUUID(),
        })
        if (result) result.textContent = 'Loading...'
      }
    })
  }

  const unsub = ctx.onBackendMessage((payload: any) => {
    if (result && payload.type === 'external_result') {
      result.textContent = JSON.stringify(payload.data, null, 2)
    } else if (result && payload.type === 'external_error') {
      result.textContent = `Error: ${payload.error}`
    }
  })

  return () => {
    unsub()
    removeStyle()
    ctx.dom.cleanup()
  }
}
```

## How It Works

1. **Frontend** injects a panel with a URL input and result display area
2. When the user presses Enter, the frontend sends a `fetch_external` message to the backend with a unique request ID
3. **Backend** receives the message, uses the CORS proxy to fetch the URL, and sends the result back
4. **Frontend** displays the JSON response or error message
5. Both modules coordinate via the `type` field in messages
