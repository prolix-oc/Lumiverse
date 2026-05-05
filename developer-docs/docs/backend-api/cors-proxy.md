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
| `responseType` | `"text" \| "arraybuffer"` | Return text or transparent binary media data |
| `mediaType` | `"image" \| "audio"` | Restrict transparent binary responses to image or audio data |

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

### Binary media responses

When `corsProxy()` is used from inside a sandbox frame for binary media, the host sets `responseType: "arraybuffer"`. The backend then:

1. Validates that the remote server's `Content-Type` matches the requested `mediaType`.
2. For images, validates magic bytes for PNG, JPEG, GIF, WebP, BMP, or SVG.
3. For audio, validates common browser-playable formats such as MP3, WAV, Ogg/Opus/Vorbis, FLAC, M4A/MP4, WebM, and MIDI.
4. Returns the body as a **base64-encoded string** (`encoding: "base64"`) so it can safely cross the WebSocket boundary.

The frontend decodes the base64 payload back into a `Uint8Array` before delivering it to the sandbox:

```ts
const bytes = await window.spindleSandbox.corsProxy('https://example.com/photo.png')
// bytes is a Uint8Array
const blob = new Blob([bytes], { type: 'image/png' })
const url = URL.createObjectURL(blob)
img.src = url
```

Sandboxed widgets can use the dedicated audio helpers instead of manually building blobs:

```ts
const audio = await window.spindleSandbox.createAudio('https://example.com/bgm.mp3', {
  controls: true,
  loop: true,
})
document.body.appendChild(audio.element)
```

If the fetched resource does not match the requested media type, the promise rejects with an error such as:

```
CORS proxy transparent proxy only serves image data (received Content-Type: application/json)
```
