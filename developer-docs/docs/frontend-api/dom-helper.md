# DOM Helper

Frontend modules run in an opaque-origin sandbox iframe. They do not receive direct access to the Lumiverse document, cookies, local storage, or IndexedDB.

The DOM helper operates inside the extension sandbox document. To show UI in Lumiverse, create a host surface with `ctx.ui.*` or render a message-scoped widget with `ctx.messages.renderWidget(...)`.

## `ctx.dom.addStyle(css)`

Add a `<style>` element inside the extension sandbox document. Returns a removal function.

```ts
const removeStyle = ctx.dom.addStyle(`
  body {
    color: var(--lumiverse-text);
  }
`)

removeStyle()
```

For visible placement or message widgets, include required styles in the HTML assigned to that host surface. Host surfaces are rendered in separate sandboxed iframes.

## `ctx.dom.createElement(tag, attrs?)`

Create an element inside the extension sandbox document.

```ts
const button = ctx.dom.createElement('button', { type: 'button' })
button.textContent = 'Click me'
```

## `ctx.dom.query(selector)` / `ctx.dom.queryAll(selector)`

Query inside the extension sandbox document.

```ts
const button = ctx.dom.query('button')
const items = ctx.dom.queryAll('[data-item]')
```

## `ctx.dom.cleanup()`

Remove DOM created inside the extension sandbox document.

```ts
ctx.dom.cleanup()
```

## Message Widgets

Use `ctx.messages.renderWidget(...)` to render interactive card UI inside a message without accessing the parent document.

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

Message widgets are host-created iframes with:

- `sandbox="allow-scripts"` only
- no `allow-same-origin`
- strict child CSP, including `connect-src 'none'`
- host-managed auto-resize
- a per-frame `window.spindleSandbox` message bridge

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
