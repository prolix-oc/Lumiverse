# Frontend Events

## `ctx.events.on(event, handler)`

Subscribe to Lumiverse WebSocket events in the browser.

```ts
const unsub = ctx.events.on('GENERATION_ENDED', (payload) => {
  const widget = ctx.dom.query('.my-widget')
  if (widget) {
    widget.textContent = `Last generation: ${payload.content?.slice(0, 50)}...`
  }
})

// Unsubscribe later
unsub()
```

Event names match the backend EventType enum values (e.g., `'GENERATION_STARTED'`, `'MESSAGE_SENT'`). See [Backend Events](../backend-api/events.md) for the full list.

## `ctx.events.emit(event, payload)`

Emit a custom event for inter-extension communication or to trigger built-in host actions.

```ts
ctx.events.emit('my_extension_data_ready', { items: [...] })
```

Custom events are dispatched as browser `CustomEvent`s with the name `spindle:{event}`.

## Built-in Events

The host app responds to the following events emitted by extensions:

| Event | Payload | Description |
|---|---|---|
| `open-settings` | `{ view?: string }` | Opens the Settings modal. Pass `view` to navigate to a specific tab (e.g. `"extensions"`, `"general"`). Defaults to `"extensions"` if omitted. |

```ts
// Open the Settings modal to the Extensions tab
ctx.events.emit('open-settings', { view: 'extensions' })
```

This is useful when your extension has configurable options in the `settings_extensions` mount and you want to direct the user there from a context menu or button.
