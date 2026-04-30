# CORS Proxy

!!! warning "Permission required: `cors_proxy`"

Make HTTP requests through the Lumiverse server, bypassing browser CORS restrictions.

## Usage

```ts
const response = await spindle.cors('https://api.example.com/data', {
  method: 'GET',
  headers: { 'Authorization': 'Bearer token123' },
})
// response: { status, statusText, headers, body }
```

## RequestInitDTO

| Field | Type | Description |
|---|---|---|
| `method` | `string` | HTTP method. Default: `"GET"` |
| `headers` | `Record<string, string>` | Request headers |
| `body` | `string` | Request body (for POST/PUT/PATCH) |

## Response Shape

```ts
{
  status: number        // 200, 404, etc.
  statusText: string    // "OK", "Not Found", etc.
  headers: Record<string, string>
  body: string          // Response body as text
}
```

## Sandboxed Widgets

Extensions that render sandboxed widgets (via `ctx.dom.createSandboxFrame()` or `ctx.messages.renderWidget()`) can also use the CORS proxy directly from inside the iframe. Sandboxed widgets run with `connect-src 'none'` in their CSP, so they cannot make direct `fetch()` calls. Instead, they can call:

```ts
const response = await window.spindleSandbox.corsProxy('https://api.example.com/image.png')
// response: { status, statusText, headers, body }
```

The `corsProxy` method is only available when:

1. The extension has the `cors_proxy` permission granted.
2. The widget is rendered inside a host-managed sandbox frame.

Requests from sandboxed widgets flow through the same host-side CORS proxy pipeline (`spindle.cors()`), so the same URL validation, SSRF protection, timeout, and body-size limits apply.
