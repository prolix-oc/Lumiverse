# UI Placement API

Beyond the basic `ctx.ui.mount()` for fixed mount points, extensions can request richer screen placements.

## Drawer Tabs (free — no permission needed)

Register a tab in the ViewportDrawer sidebar. Max 4 per extension, 8 global.

Drawer tabs are managed by Lumiverse's central tab registry. When you register a tab, it automatically appears in the sidebar **and** the command palette (`Ctrl+K`). The metadata you provide controls how the tab looks and how users find it.

```ts
const tab = ctx.ui.registerDrawerTab({
  id: 'stats',
  title: 'Character Stats',
  shortName: 'Stats',                        // sidebar icon label (max ~8 chars)
  description: 'View character performance metrics and trends',  // command palette subtitle
  keywords: ['analytics', 'metrics', 'data', 'charts'],         // fuzzy search terms
  headerTitle: 'Stats',                       // panel header (shorter than full title)
  iconSvg: '<svg>...</svg>',                  // 20x20 inline SVG
})

// Render into the tab's content area
const h2 = document.createElement('h2')
h2.textContent = 'Hello from my extension!'
tab.root.appendChild(h2)

// Update badge
tab.setBadge('3')

// Update the sidebar label at runtime
tab.setShortName('Stats!')

// Programmatically switch to this tab
tab.activate()

// Listen for activation
const unsub = tab.onActivate(() => {
  console.log('User switched to my tab')
})

// Cleanup
tab.destroy()
```

### SpindleDrawerTabOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `id` | `string` | *required* | Unique identifier within your extension |
| `title` | `string` | *required* | Full display title. Shown in the panel header and command palette listing. |
| `shortName` | `string` | truncated `title` | Short label rendered beneath the sidebar icon. Keep to ~8 characters. Longer values are truncated with an ellipsis. |
| `description` | `string` | `"Open {title} extension tab"` | One-line description shown below the title in the command palette. |
| `keywords` | `string[]` | `[]` | Additional terms for command palette fuzzy search. Your extension name is always included automatically. |
| `headerTitle` | `string` | `title` | Title shown in the panel header navbar. Useful when the header should be shorter than the full command palette entry. |
| `iconSvg` | `string` | — | Inline SVG string for the tab icon. Rendered at 20x20. Sanitized via DOMPurify. |
| `iconUrl` | `string` | — | URL to an icon image (16x16 or 24x24). Mutually exclusive with `iconSvg`. |

### SpindleDrawerTabHandle

| Method / Property | Returns | Description |
|---|---|---|
| `root` | `HTMLElement` | The tab's content container. Render your UI into this element. |
| `tabId` | `string` | The scoped tab ID assigned by the host. |
| `setTitle(title)` | `void` | Update the full title (affects command palette and panel header). |
| `setShortName(shortName)` | `void` | Update the sidebar icon label. |
| `setBadge(text)` | `void` | Show a badge next to the tab icon. Pass `null` to clear. |
| `activate()` | `void` | Programmatically switch the drawer to this tab. |
| `destroy()` | `void` | Remove the tab and all event listeners. |
| `onActivate(handler)` | `() => void` | Register a callback fired when the user switches to this tab. Returns an unsubscribe function. |

### Command Palette Integration

Every registered drawer tab is automatically available in the command palette. Users can open your tab by pressing `Ctrl+K` (or `Cmd+K`) and typing any of these:

- The tab `title` or `shortName`
- Any word from `description`
- Any entry in `keywords`
- Your extension's identifier

No extra code needed. The registry handles the wiring.

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

## Context Menu (free — no permission needed)

Show a themed context menu at any screen position and wait for the user's selection. The menu is rendered by Lumiverse using the system theme — it automatically matches the user's accent color, glass mode, and dark/light preference. On mobile, pair this with a long-press gesture to replace right-click.

```ts
const { selectedKey } = await ctx.ui.showContextMenu({
  position: { x: event.clientX, y: event.clientY },
  items: [
    { key: 'small', label: 'Small', active: currentSize === 'small' },
    { key: 'medium', label: 'Medium', active: currentSize === 'medium' },
    { key: 'large', label: 'Large', active: currentSize === 'large' },
    { key: 'div', label: '', type: 'divider' },
    { key: 'reset', label: 'Reset Position' },
    { key: 'delete', label: 'Delete Widget', danger: true },
  ],
})

if (selectedKey === 'small') {
  // handle selection
} else if (selectedKey === null) {
  // user dismissed the menu without selecting
}
```

The method returns a Promise that resolves when the user selects an item or dismisses the menu.

### SpindleContextMenuOptions

| Field | Type | Description |
|---|---|---|
| `position` | `{ x: number, y: number }` | Screen coordinates to anchor the menu |
| `items` | `SpindleContextMenuItemDef[]` | Menu entries (see below) |

### SpindleContextMenuItemDef

| Field | Type | Default | Description |
|---|---|---|---|
| `key` | `string` | *required* | Unique key returned when this item is selected |
| `label` | `string` | *required* | Display text (ignored for dividers) |
| `type` | `'item' \| 'divider'` | `'item'` | Set to `'divider'` for a visual separator |
| `disabled` | `boolean` | `false` | Greyed out and not clickable |
| `danger` | `boolean` | `false` | Rendered in red/danger style |
| `active` | `boolean` | `false` | Highlighted to indicate current selection |

### SpindleContextMenuResult

| Field | Type | Description |
|---|---|---|
| `selectedKey` | `string \| null` | The `key` of the chosen item, or `null` if the menu was dismissed |

### Mobile Support

The context menu is triggered by `contextmenu` events (right-click on desktop), but mobile browsers don't reliably fire this event. To support mobile users, add a long-press (touch-and-hold) gesture:

```ts
let longPressTimer: ReturnType<typeof setTimeout> | null = null
let longPressFired = false
let longPressStart = { x: 0, y: 0 }

element.addEventListener('touchstart', (e) => {
  longPressFired = false
  const touch = e.touches[0]
  longPressStart = { x: touch.clientX, y: touch.clientY }
  longPressTimer = setTimeout(() => {
    longPressFired = true
    navigator.vibrate?.(50) // haptic feedback
    showContextMenu(touch.clientX, touch.clientY)
  }, 500)
}, { passive: true })

element.addEventListener('touchmove', (e) => {
  if (!longPressTimer) return
  const touch = e.touches[0]
  const dx = Math.abs(touch.clientX - longPressStart.x)
  const dy = Math.abs(touch.clientY - longPressStart.y)
  if (dx > 10 || dy > 10) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}, { passive: true })

element.addEventListener('touchend', (e) => {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null }
  if (longPressFired) { e.preventDefault(); longPressFired = false }
})
```

!!! tip "Why use the system context menu?"
    - **Themed automatically** — matches the user's accent color, glass blur, dark/light mode
    - **Viewport-clamped** — the menu repositions itself to stay on screen
    - **Keyboard accessible** — dismisses on Escape
    - **Consistent UX** — users get the same look and feel across all extensions
    - **No CSS to maintain** — no need to ship your own menu styles

## Modal (free — no permission needed)

Open a system-themed modal overlay. Lumiverse renders the chrome — backdrop, header with title and close button, animations, Escape key handling — and the extension fully owns the body content via the returned handle's `root` element.

Modals automatically inherit the user's theme, accent color, glass mode, and dark/light preference. No CSS is required from the extension for the modal chrome itself.

```ts
const modal = ctx.ui.showModal({
  title: 'Nudge History',
})

// Build content into the modal body
const list = document.createElement('ul')
list.innerHTML = '<li>First nudge</li><li>Second nudge</li>'
modal.root.appendChild(list)

// Update title dynamically
modal.setTitle('Nudge History (2 items)')

// Listen for dismissal
modal.onDismiss(() => {
  console.log('Modal was closed')
})

// Close programmatically
modal.dismiss()
```

### SpindleModalOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `title` | `string` | *required* | Title displayed in the modal header |
| `width` | `number` | `420` | Width in pixels. Clamped to viewport. |
| `maxHeight` | `number` | `520` | Maximum height in pixels. Clamped to viewport. |
| `persistent` | `boolean` | `false` | When `true`, clicking the backdrop does not dismiss the modal. The user must use the close button or the extension must call `dismiss()`. |

### SpindleModalHandle

| Method / Property | Returns | Description |
|---|---|---|
| `root` | `HTMLElement` | The body container element. The extension fully owns this element's contents. |
| `modalId` | `string` | Unique modal ID assigned by the host |
| `dismiss()` | `void` | Programmatically close the modal |
| `setTitle(title)` | `void` | Update the header title |
| `onDismiss(handler)` | `() => void` | Register a callback invoked when the modal is dismissed (by the user, by `dismiss()`, or by extension cleanup). Returns an unsubscribe function. |

### Stack Limit

Extensions may have at most **2 stacked modals** open simultaneously — for example, one primary modal and one nested text editor or confirmation prompt. Attempting to open a third modal throws an error.

This limit is enforced per extension. Different extensions can each have their own modals open independently.

### Backend-Initiated Modals

Backend extensions can also open modals via `spindle.modal.open()`. Since the backend can't inject DOM, it provides structured content items that the host renders into the modal body. See [Modal](../backend-api/modal.md) in the Backend API docs.

### Example: History Viewer

```ts
// Fetch data from backend, then present in a modal
ctx.onBackendMessage((payload: any) => {
  if (payload.type === 'history_loaded') {
    const modal = ctx.ui.showModal({ title: 'Recent Activity' })

    if (payload.entries.length === 0) {
      modal.root.innerHTML = '<p style="text-align:center;color:var(--lumiverse-text-dim)">No activity yet.</p>'
      return
    }

    for (const entry of payload.entries) {
      const card = document.createElement('div')
      card.style.cssText = `
        padding: 10px 12px;
        margin-bottom: 8px;
        background: var(--lumiverse-fill-subtle);
        border: 1px solid var(--lumiverse-border);
        border-radius: var(--lumiverse-radius);
      `
      card.innerHTML = `
        <div style="font-size:12.5px;color:var(--lumiverse-text)">${entry.text}</div>
        <div style="margin-top:6px;font-size:11px;color:var(--lumiverse-text-dim)">${entry.time}</div>
      `
      modal.root.appendChild(card)
    }
  }
})
```

!!! tip "When to use a modal vs. a drawer tab"
    - **Modal** — transient content the user views and dismisses: history, previews, confirmations, detail views. The user's attention is focused on the modal content.
    - **Drawer tab** — persistent UI the user returns to repeatedly: configuration panels, dashboards, settings. The tab stays available in the sidebar.

## Confirmation Modal (free — no permission needed)

Show a system-themed confirmation dialog and wait for the user's response. The host renders a modal with a message, a variant-colored confirm button, and a cancel button. Useful for gating destructive actions, confirming settings changes, or requiring explicit user consent.

```ts
const { confirmed } = await ctx.ui.showConfirm({
  title: 'Delete History',
  message: 'This will permanently erase all nudge history for this character. This action cannot be undone.',
  variant: 'danger',
  confirmLabel: 'Delete',
})

if (confirmed) {
  ctx.sendToBackend({ type: 'delete_history', characterId })
}
```

The method returns a Promise that resolves when the user clicks confirm, clicks cancel, or dismisses the modal. Counts toward the **2 stacked modals** limit per extension.

### Variants

The `variant` option controls the visual style of the confirm button to signal intent:

| Variant | Button Color | Use For |
|---|---|---|
| `'info'` | Neutral / blue (default) | General confirmations, informational prompts |
| `'warning'` | Yellow / amber | Actions with side effects the user should be aware of |
| `'danger'` | Red | Destructive or irreversible actions (delete, clear, reset) |
| `'success'` | Green | Positive confirmations (enable, activate, approve) |

### SpindleConfirmOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `title` | `string` | *required* | Title displayed in the modal header |
| `message` | `string` | *required* | Body text explaining what the user is confirming |
| `variant` | `'info' \| 'warning' \| 'danger' \| 'success'` | `'info'` | Visual style for the confirm button |
| `confirmLabel` | `string` | `"Confirm"` | Label for the primary action button |
| `cancelLabel` | `string` | `"Cancel"` | Label for the secondary dismiss button |

### SpindleConfirmResult

| Field | Type | Description |
|---|---|---|
| `confirmed` | `boolean` | `true` if the user clicked confirm, `false` if they cancelled or dismissed |

### Backend-Initiated Confirmations

Backend extensions can also show confirmations via `spindle.modal.confirm()`. See [Modal](../backend-api/modal.md#confirmation) in the Backend API docs.

### Example: Guarding a Destructive Action

```ts
const resetBtn = document.createElement('button')
resetBtn.textContent = 'Reset All Settings'
resetBtn.addEventListener('click', async () => {
  const { confirmed } = await ctx.ui.showConfirm({
    title: 'Reset Settings',
    message: 'All per-character configurations will be reset to defaults. Global defaults will not be affected.',
    variant: 'warning',
    confirmLabel: 'Reset',
  })
  if (confirmed) {
    ctx.sendToBackend({ type: 'reset_all_configs' })
  }
})
```

## Capacity Limits

| Placement | Per Extension | Global |
|---|---|---|
| Drawer Tab | 4 | 8 |
| Float Widget | 2 | 8 |
| Dock Panel | 1 per edge | 2 per edge |
| App Mount | 1 | 4 |
| Input Bar Action | 4 | 12 |
| Modal | 2 stacked | — |

Exceeding limits throws an error. All placements are automatically cleaned up when an extension is disabled or removed.

## User Control

Users can show/hide individual extension UI elements from the **Extension UI** control panel in the Extensions drawer tab. Right-clicking a float widget also provides hide and reset-position options.
