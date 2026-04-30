# DOM Helper

Frontend modules run in the browser and can render UI in two ways:

- direct host DOM rendering through `ctx.dom.*` and `ctx.ui.*` roots
- isolated iframe rendering through `ctx.dom.createSandboxFrame(...)` or `ctx.messages.renderWidget(...)`

Use the direct host DOM path for ordinary extension UI. Use sandbox frames when you need scriptable HTML that should run in its own isolated document.

## `ctx.dom.inject(target, html, position?)`

Inject sanitized HTML into the host document.

```ts
const card = ctx.dom.inject(
  '[data-spindle-mount="sidebar"]',
  `
    <section class="demo-card">
      <h2>My Panel</h2>
      <p>Rendered directly into the host DOM.</p>
    </section>
  `,
)
```

Injected HTML is sanitized with DOMPurify before insertion.

## `ctx.dom.addStyle(css)`

Add a `<style>` element to the host document. Returns a removal function.

```ts
const removeStyle = ctx.dom.addStyle(`
  .demo-card {
    color: var(--lumiverse-text);
    padding: 12px;
  }
`)

removeStyle()
```

For direct host DOM rendering, this is usually the simplest way to style your injected UI.

## `ctx.dom.createElement(tag, attrs?)`

Create an element in the host document.

```ts
const button = ctx.dom.createElement('button', { type: 'button' })
button.textContent = 'Click me'
```

Raw `iframe`, `frame`, `object`, and `embed` tags are blocked. Use `ctx.dom.createSandboxFrame(...)` when you need an isolated child document.

## `ctx.dom.createSandboxFrame(options)`

Create a host-managed sandboxed iframe for isolated scriptable content.

```ts
const frame = ctx.dom.createSandboxFrame({
  html: `
    <style>
      body { margin: 0; padding: 12px; color: white; background: #111; }
      button { padding: 8px 12px; }
    </style>
    <button id="ping">Ping host</button>
    <script>
      document.getElementById('ping').addEventListener('click', () => {
        window.spindleSandbox.postMessage({ type: 'ping' })
      })
    </script>
  `,
  minHeight: 48,
})

frame.onMessage((payload) => {
  console.log('frame message', payload)
})

someRoot.appendChild(frame.element)
```

Use this when the child content needs its own document, inline scripts, or stricter isolation than the normal host DOM path.

### `window.spindleSandbox` API

Inside a sandbox frame, the host injects a minimal API on `window.spindleSandbox`:

| Method | Description |
|---|---|
| `postMessage(payload)` | Send a message to the host extension |
| `onMessage(handler)` | Listen for messages from the host extension |
| `requestResize(height?)` | Ask the host to resize the iframe |
| `corsProxy(url, options?)` | Fetch a URL through the extension's CORS proxy (requires `cors_proxy` permission) |

```ts
// Inside the sandboxed iframe HTML
const bytes = await window.spindleSandbox.corsProxy('https://example.com/avatar.png')
// bytes is a Uint8Array containing the raw image data
const blob = new Blob([bytes], { type: 'image/png' })
const url = URL.createObjectURL(blob)
document.getElementById('avatar').src = url
```

`corsProxy` is only available if the extension has the `cors_proxy` permission. It routes requests through the backend worker's existing `spindle.cors()` path, so the same SSRF validation, timeouts, and response-size limits apply.

**Important:** the transparent proxy only serves **image** content. The backend validates both the `Content-Type` header (`image/*`) and the file magic bytes before returning data. Non-image requests are rejected.

## `ctx.dom.query(selector)` / `ctx.dom.queryAll(selector)`

Query inside the extension-owned host DOM.

```ts
const button = ctx.dom.query('button')
const items = ctx.dom.queryAll('[data-item]')
```

## `ctx.dom.cleanup()`

Remove DOM created by the helper.

```ts
ctx.dom.cleanup()
```

## Message Widgets

Use `ctx.messages.renderWidget(...)` to render interactive card UI inside a message-scoped sandbox frame.

```ts
const cleanup = ctx.messages.renderWidget(
  {
    messageId: payload.messageId,
    widgetId: 'my-card-widget',
    html: `
      <style>button { padding: 8px 12px; }</style>
      <button id="send">Send event</button>
      <script>
        document.getElementById('send').addEventListener('click', () => {
          window.spindleSandbox.postMessage({ type: 'clicked' })
        })
      </script>
    `,
  },
  (message) => {
    console.log('widget event', message)
  },
)

cleanup()
```

Message widgets use the isolated iframe path. They are host-created iframes with:

- `sandbox="allow-scripts"` only
- no `allow-same-origin`
- strict child CSP, including `connect-src 'none'`
- host-managed auto-resize
- a per-frame `window.spindleSandbox` message bridge
- optional `window.spindleSandbox.corsProxy()` when the `cors_proxy` permission is granted

## Lumiverse CSS Variables

Use these variables in widget HTML to match the current theme:

| Variable | Description |
|----------|-------------|
| `--lumiverse-text` | Primary text color |
| `--lumiverse-text-muted` | Muted text color |
| `--lumiverse-text-dim` | Dim text color |
| `--lumiverse-fill` | Primary fill/background |
| `--lumiverse-fill-subtle` | Subtle fill/background |
| `--lumiverse-border` | Border color |
| `--lumiverse-border-hover` | Border hover color |
| `--lumiverse-accent` | Accent color |
| `--lumiverse-accent-fg` | Accent foreground color |
| `--lumiverse-radius` | Border radius |
| `--lumiverse-transition-fast` | Fast transition duration |
