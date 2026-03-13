# UI Placement API

Beyond the basic `ctx.ui.mount()` for fixed mount points, extensions can request richer screen placements.

## Drawer Tabs (free — no permission needed)

Register a tab in the ViewportDrawer sidebar. Max 4 per extension, 8 global.

```ts
const tab = ctx.ui.registerDrawerTab({
  id: 'stats',           // unique within your extension
  title: 'My Stats',
  iconSvg: '<svg>...</svg>',  // 20x20 inline SVG
})

// Render into the tab's content area
const h2 = document.createElement('h2')
h2.textContent = 'Hello from my extension!'
tab.root.appendChild(h2)

// Update badge
tab.setBadge('3')

// Programmatically switch to this tab
tab.activate()

// Listen for activation
const unsub = tab.onActivate(() => {
  console.log('User switched to my tab')
})

// Cleanup
tab.destroy()
```

## Float Widgets (requires `ui_panels`)

Create a small draggable widget overlaying the UI. Max 2 per extension, 8 global.

```ts
const widget = ctx.ui.createFloatWidget({
  width: 48,
  height: 48,
  initialPosition: { x: 100, y: 100 },
  snapToEdge: true,
  tooltip: 'My Widget',
  chromeless: true,   // strip default chrome — extension owns all styling
})

// Render into the widget
widget.root.innerHTML = '<button>Click</button>'

// Move programmatically
widget.moveTo(200, 200)

// Read current position
const pos = widget.getPosition() // { x: number, y: number }

// Show/hide
widget.setVisible(false)
widget.setVisible(true)
console.log(widget.isVisible()) // false

// Listen for drag end
widget.onDragEnd((pos) => {
  console.log('Widget dropped at', pos.x, pos.y)
})

widget.destroy()
```

### SpindleFloatWidgetOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `width` | `number` | — | Widget width in pixels |
| `height` | `number` | — | Widget height in pixels |
| `initialPosition` | `{ x, y }` | — | Starting position in viewport coordinates |
| `snapToEdge` | `boolean` | — | Snap to the nearest screen edge after drag |
| `tooltip` | `string` | — | Hover tooltip text |
| `chromeless` | `boolean` | `false` | Strip the default container chrome (border, background, shadow, border-radius). The extension fully owns the visual presentation. |

## Dock Panels (requires `ui_panels`)

Create an always-visible panel fixed to a screen edge. Max 1 per edge per extension, 2 per edge global.

```ts
const panel = ctx.ui.requestDockPanel({
  edge: 'right',
  title: 'My Panel',
  size: 300,            // width in px (for left/right edges)
  minSize: 200,
  maxSize: 600,
  resizable: true,
  startCollapsed: false,
})

// Render into the panel
panel.root.innerHTML = '<div>Panel content</div>'

// Collapse / expand
panel.collapse()
panel.expand()
console.log(panel.isCollapsed())

// Listen for visibility changes
panel.onVisibilityChange((visible) => {
  console.log('Panel is now', visible ? 'visible' : 'collapsed')
})

panel.destroy()
```

On mobile, left/right dock panels become full-width bottom sheets.

## App Mounts (requires `app_manipulation`)

Mount an unrestricted portal into `document.body` that persists across route changes. Max 1 per extension, 4 global.

```ts
const mount = ctx.ui.mountApp({
  className: 'my-ext-overlay',
  position: 'end',     // 'start' or 'end' of body
})

// Full control over the mount
mount.root.innerHTML = '<div class="my-fullscreen-overlay">...</div>'

// Show/hide
mount.setVisible(false)

mount.destroy()
```

## Input Bar Actions (free — no permission needed)

Register action buttons inside the **Extras** popover on the chat input bar. Extension actions are visually grouped under a teal-badged header with the extension name. Max 4 per extension, 12 global.

```ts
const action = ctx.ui.registerInputBarAction({
  id: 'quick-translate',        // unique within your extension
  label: 'Translate Last Reply',
  iconSvg: '<svg>...</svg>',    // optional 14x14 inline SVG
  // iconUrl: '/icon.png',      // alternative: URL to an icon image
  enabled: true,                // default true — disabled actions are hidden
})

// React to clicks
const unsub = action.onClick(() => {
  console.log('User clicked my action!')
})

// Update label dynamically
action.setLabel('Translate to Spanish')

// Temporarily disable (hides from popover)
action.setEnabled(false)
action.setEnabled(true)

// Remove click listener
unsub()

// Cleanup — removes the action from the popover entirely
action.destroy()
```

### SpindleInputBarActionOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `id` | `string` | *required* | Unique identifier within your extension |
| `label` | `string` | *required* | Display label shown in the popover row |
| `iconSvg` | `string` | — | Inline SVG string (sanitized via DOMPurify). Rendered at 14x14. |
| `iconUrl` | `string` | — | URL to an icon image. Takes precedence over `iconSvg` if both are set. |
| `enabled` | `boolean` | `true` | When `false`, the action is hidden from the popover. |

### SpindleInputBarActionHandle

| Method | Returns | Description |
|---|---|---|
| `actionId` | `string` | The scoped ID assigned to this action |
| `setLabel(label)` | `void` | Update the display label |
| `setEnabled(enabled)` | `void` | Show/hide the action in the popover |
| `onClick(handler)` | `() => void` | Register a click handler. Returns an unsubscribe function. Multiple handlers are supported. |
| `destroy()` | `void` | Remove the action and all handlers |

Clicking an extension action in the Extras popover fires all registered `onClick` handlers and automatically closes the popover.

## Capacity Limits

| Placement | Per Extension | Global |
|---|---|---|
| Drawer Tab | 4 | 8 |
| Float Widget | 2 | 8 |
| Dock Panel | 1 per edge | 2 per edge |
| App Mount | 1 | 4 |
| Input Bar Action | 4 | 12 |

Exceeding limits throws an error. All placements are automatically cleaned up when an extension is disabled or removed.

## User Control

Users can show/hide individual extension UI elements from the **Extension UI** control panel in the Extensions drawer tab. Right-clicking a float widget also provides hide and reset-position options.
