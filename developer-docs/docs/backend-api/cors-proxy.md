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
