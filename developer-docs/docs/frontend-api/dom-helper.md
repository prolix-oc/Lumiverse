# DOM Helper

Frontend modules run in the browser and can render UI in two ways:

- direct host DOM rendering through `ctx.dom.*` and `ctx.ui.*` roots
- isolated iframe rendering through `ctx.dom.createSandboxFrame(...)` or `ctx.messages.renderWidget(...)`

Use the direct host DOM path for ordinary extension UI. Use sandbox frames when you need scriptable HTML that should run in its own isolated document.

## `ctx.dom.inject(target, html, position?)`

Inject sanitized HTML into the host document. Returns the wrapper element containing the parsed content.

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

**Element identity is preserved across chat-list virtualization.** When the injection lands inside a message bubble, the host keeps a reference to the wrapper and *moves* (not recreates) it back into place when the bubble next mounts. Form-control state, event listeners attached to the wrapper subtree, and any refs you cached all survive scroll-away/scroll-back round trips. The returned `Element` stays valid until you explicitly retire it. See [Persistence Across Virtualization](#persistence-across-virtualization) for the full contract.

## `ctx.dom.uninject(element)`

Retire an injection previously returned by `inject()`. Removes the wrapper from the DOM **and** drops its replay registration so the host won't restore it on future bubble remounts.

```ts
const tracker = ctx.dom.inject(bubble, html, 'beforeend')
// …later, when you want to drop it:
ctx.dom.uninject(tracker)
```

Use this — not `tracker.remove()` — to deliberately remove a message-targeted injection. Calling `.remove()` directly detaches the wrapper from the DOM but leaves the registry record in place, so the host will resurrect the wrapper the next time the bubble remounts. `uninject()` is a no-op for elements that aren't recognised Spindle wrappers, so it's safe to call defensively.

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
| `fetchAudio(url, options?)` | Fetch remote audio through the CORS proxy and return a sandbox-local blob URL |
| `createAudio(url, options?)` | Fetch remote audio through the CORS proxy and return a configured `HTMLAudioElement` handle |
| `fetchFont(url, options?)` | Fetch a remote web font through the CORS proxy and return a sandbox-local blob URL usable in `@font-face src: url(...)` |

```ts
// Inside the sandboxed iframe HTML
const bytes = await window.spindleSandbox.corsProxy('https://example.com/avatar.png')
// bytes is a Uint8Array containing the raw image data
const blob = new Blob([bytes], { type: 'image/png' })
const url = URL.createObjectURL(blob)
document.getElementById('avatar').src = url
```

`corsProxy`, `fetchAudio`, `createAudio`, and `fetchFont` are only available if the extension has the `cors_proxy` permission. They route requests through the backend worker's existing `spindle.cors()` path, so the same SSRF validation, timeouts, and response-size limits apply.

**Important:** the transparent proxy only serves approved **image**, **audio**, or **web font** content. The backend validates both the `Content-Type` header and file magic bytes before returning data. Other requests are rejected.

```ts
// Inside the sandboxed iframe HTML
const bgm = await window.spindleSandbox.createAudio('https://example.com/bgm.mp3', {
  controls: true,
  loop: true,
  volume: 0.6,
})
document.body.appendChild(bgm.element)
```

```ts
// Inside the sandboxed iframe HTML
const font = await window.spindleSandbox.fetchFont('https://fonts.gstatic.com/s/inter/v13/UcC73FwrK3iLTeHuS_fvQtMwCp50KnMa1pL7SUc.woff2')
const style = document.createElement('style')
style.textContent = `@font-face { font-family: 'Inter'; src: url("${font.url}") format("woff2"); } body { font-family: 'Inter', sans-serif; }`
document.head.appendChild(style)
```

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

## Message-Targeted Injection

For extensions that render content on specific chat message bubbles — trackers, summaries, per-message decorations — the host exposes helpers for looking up message ids and bubble elements, plus an invisible registry that re-attaches your injected DOM whenever the virtualized chat list mounts a bubble back into view.

Together they let you write:

```ts
function attachTracker() {
  const latestId = ctx.messages.getLatestMessageId()
  if (!latestId) return

  const bubble = ctx.dom.findMessageElement(latestId)
  if (!bubble) return // currently scrolled out; nothing to inject this tick

  ctx.dom.inject(bubble, '<div class="tracker">…</div>', 'beforeend')
}
```

…and the tracker DOM survives the user scrolling away and back. The host re-injects it automatically on bubble remount, without your extension having to subscribe to anything.

## `ctx.dom.getMessageId(target)`

Resolve the chat message that contains a DOM element. Walks up from `target` looking for the host's message-bubble anchor and returns the stable message id, or `null` if the element isn't inside any chat message (sidebar, modal, floating widget, etc).

```ts
button.addEventListener('click', (e) => {
  const messageId = ctx.dom.getMessageId(e.target as Element)
  if (messageId) console.log('clicked inside message', messageId)
})
```

Prefer this over reading host DOM attributes directly. The underlying attribute is a private implementation detail; `getMessageId` is the stable public contract.

## `ctx.dom.findMessageElement(messageId)`

Look up the bubble element currently mounted for a given message id. Returns `null` when the bubble isn't currently in the DOM — the chat list is virtualized, so only bubbles near the viewport (plus a small overscan window) are mounted at any time.

```ts
const bubble = ctx.dom.findMessageElement(latestId)
if (bubble) {
  ctx.dom.inject(bubble, html, 'beforeend')
}
```

If `null` comes back, the bubble isn't currently visible. Any injection you previously registered against that bubble is auto-replayed when it next mounts (see [Persistence Across Virtualization](#persistence-across-virtualization)).

## `ctx.dom.listMessageElements()`

Enumerate every chat message bubble currently mounted in the DOM, paired with its stable message id. Reflects only what the virtualizer has rendered (typically the viewport + a small overscan window), so the list changes as the user scrolls.

```ts
for (const { messageId, element } of ctx.dom.listMessageElements()) {
  ctx.dom.inject(element, decorateForMessage(messageId))
}
```

## `ctx.messages.getLatestMessageId()`

Get the most recent message id in the active chat, or `null` if the chat is empty or no chat is active. Reflects the full chat history — works even when the latest bubble is currently scrolled off-screen.

```ts
const latestId = ctx.messages.getLatestMessageId()
```

## `ctx.messages.getMessageIdAtIndex(index)`

Get the message id at a given chronological index in the active chat. Negative indices count from the end Python-style: `-1` is the latest message, `-2` the second-latest. Returns `null` if the index is out of range or no chat is active.

```ts
const lastFive = [-5, -4, -3, -2, -1]
  .map((i) => ctx.messages.getMessageIdAtIndex(i))
  .filter((id): id is string => id !== null)
```

## `ctx.messages.listMessageIds()`

Enumerate every message id in the active chat in chronological order (oldest first, newest last). Reflects the full chat history, not just what's currently mounted in the DOM — see `ctx.dom.listMessageElements()` for the mounted-only DOM view.

```ts
const ids = ctx.messages.listMessageIds()
console.log('chat has', ids.length, 'messages')
```

## Persistence Across Virtualization

The chat message list is virtualized: bubbles that scroll out of view (past the overscan window) have their DOM unmounted to save memory. Without intervention, anything an extension injected with `ctx.dom.inject()` into those bubbles would be destroyed.

To avoid that, the host runs an injection registry behind the scenes:

- Every `ctx.dom.inject(target, html, position?)` call whose `target` resolves inside a chat message bubble is recorded with the wrapper element itself, the sanitized HTML (as a rebuild fallback), the wrapper's relative path within the bubble, and the insert position.
- When the virtualizer remounts a bubble, the host moves the original wrapper back into the same relative location — synchronously, before paint, via `useLayoutEffect`. Identity is preserved, so form-control state, event listeners bound to the subtree, refs you've stashed, and any in-flight `<audio>`/`<video>` elements all carry through untouched. Your extension sees nothing.
- Records are dropped automatically when:
    - the targeted message is deleted from the chat
    - the user navigates to a different chat
    - the extension calls `ctx.dom.cleanup()` or is uninstalled
    - the extension calls `ctx.dom.uninject(wrapper)` for an individual injection

You don't need to subscribe to anything, poll the DOM, or re-inject on scroll. Both static decorations and stateful widgets are durable.

Injections whose `target` resolves **outside** a message bubble (chat header, sidebar, modals, floating widgets) are not registered. Those host regions aren't virtualized, so the original wrapper stays put on its own.

### Caveats

- **Deliberate removal must go through `uninject()`.** If you call `.remove()` on a registered wrapper, you detach it from the DOM but leave the registry record in place — the host will reattach the wrapper the next time the bubble mounts. Use `ctx.dom.uninject(wrapper)` (or `ctx.dom.cleanup()` for everything) to retire an injection permanently.
- **Structurally-unstable selectors.** Injections targeted at deeply nested elements identified by `:nth-child` paths may fail to replay if the host bubble's internal structure changes between mount and remount. The host logs a console warning and skips the affected record rather than throwing. Prefer injecting at the bubble root (the element returned by `findMessageElement()`) and letting your own HTML own the layout below that.

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
