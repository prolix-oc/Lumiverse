# DOM Helper

All HTML injection is sanitized through DOMPurify. Elements are tracked per-extension and automatically scoped.

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
