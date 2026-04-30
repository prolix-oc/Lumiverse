# DOM Helper

All HTML injection is sanitized through DOMPurify. Elements are tracked per-extension and automatically scoped.

For scriptable widgets, use `ctx.dom.createSandboxFrame(...)`. Raw `iframe`, `frame`, `object`, and `embed` creation is intentionally blocked from the DOM helper.

## `ctx.dom.inject(target, html, position?)`

Inject sanitized HTML into the page.

```ts
// Inject into a CSS-selected target
ctx.dom.inject('#chat-container', '<div class="my-widget">Hello!</div>', 'beforeend')

// Position options: 'beforebegin', 'afterbegin', 'beforeend', 'afterend'
// Default: 'beforeend'
```

Returns the wrapper `Element` that was inserted.

## `ctx.dom.addStyle(css)`

Add a `<style>` element scoped to your extension. Returns a removal function.

```ts
const removeStyle = ctx.dom.addStyle(`
  .my-widget {
    padding: 12px;
    background: var(--lumiverse-fill-subtle);
    border: 1px solid var(--lumiverse-border);
    border-radius: var(--lumiverse-radius);
    color: var(--lumiverse-text);
  }
`)

// Remove later
removeStyle()
```

### Lumiverse CSS Variables

Use these variables to match the current theme:

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

## `ctx.dom.createElement(tag, attrs?)`

Create a tracked element without injecting it yet.

```ts
const btn = ctx.dom.createElement('button', {
  class: 'my-ext-btn',
  'data-action': 'toggle',
})
btn.textContent = 'Click me'
btn.addEventListener('click', () => { /* ... */ })
```

`createElement()` cannot create `iframe`, `frame`, `object`, or `embed` tags. Use `createSandboxFrame()` when you need isolated HTML/CSS/JS execution.

## `ctx.dom.createSandboxFrame(options)`

Create a host-managed sandboxed iframe for extension-owned HTML/CSS/JS.

The host always applies:

- `sandbox="allow-scripts"` only
- no `allow-same-origin`
- a strict child-document CSP
- a narrow `postMessage` bridge keyed per frame
- host-managed auto-resize

Use this when you need widget-local script execution without giving that widget access to the parent Lumiverse document.

```ts
const frame = ctx.dom.createSandboxFrame({
  html: `
    <div id="root">Loading...</div>
    <script>
      const root = document.getElementById('root')
      root.textContent = 'Hello from the sandbox'

      window.spindleSandbox.onMessage((payload) => {
        root.textContent = String(payload)
      })

      window.spindleSandbox.postMessage({ type: 'ready' })
    </script>
  `,
  autoResize: true,
  minHeight: 40,
  maxHeight: 600,
})

frame.onMessage((payload) => {
  console.log('sandbox -> host', payload)
})

frame.postMessage('Updated by host')
document.body.appendChild(frame.element)
```

### Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `html` | `string` | required | HTML document or fragment rendered inside the child iframe |
| `autoResize` | `boolean` | `true` | Resize the host iframe as the child content changes |
| `initialHeight` | `number` | `minHeight` or `40` | Initial iframe height in CSS pixels |
| `minHeight` | `number` | `40` | Minimum iframe height |
| `maxHeight` | `number` | `4000` | Maximum iframe height |

### Returned Handle

| Method | Description |
|--------|-------------|
| `element` | The sandboxed `HTMLIFrameElement` to place in the DOM |
| `setContent(html)` | Replace the child document contents |
| `postMessage(payload)` | Send a payload into the child sandbox runtime |
| `onMessage(handler)` | Receive payloads posted from the child sandbox runtime |
| `destroy()` | Remove the iframe and tear down the host bridge |

### Child Runtime API

Inside the sandboxed document, the host exposes `window.spindleSandbox`:

| Method | Description |
|--------|-------------|
| `postMessage(payload)` | Send a payload to the extension host |
| `onMessage(handler)` | Receive payloads sent by `frame.postMessage(...)` |
| `requestResize(height?)` | Ask the host to resize immediately |

### Security Notes

- The child iframe has an opaque origin. It cannot access `window.parent.document`, cookies, or Lumiverse app state.
- The child CSP is intentionally restrictive. Network access is blocked (`connect-src 'none'`), and nested frames/workers are blocked.
- This protects the parent document from widget code. It does not sandbox your extension frontend module itself; your frontend module still runs in the main document context.

## `ctx.dom.query(selector)` / `ctx.dom.queryAll(selector)`

Query only within your extension's own injected elements.

```ts
const widget = ctx.dom.query('.my-widget')
const allButtons = ctx.dom.queryAll('button')
```

## `ctx.dom.cleanup()`

Remove all elements and styles injected by your extension.

```ts
ctx.dom.cleanup()
```
