# UI Events Helper

The `ctx.ui.events` object provides reactive subscriptions to Lumiverse UI state (keyboard, drawer, settings) and a generic DOM event delegation helper. This is particularly useful for tracking mobile keyboard dimensions and for binding interactions on extension-injected or mounted DOM elements without leaking global event listeners.

## Keyboard State
Access the virtual keyboard presence and safe-area inset (especially on iOS PWA or Android Chrome where the window resizing or visual viewport varies).

```ts
export interface SpindleUIKeyboardState {
  /** True when the host believes a virtual keyboard is currently visible. */
  visible: boolean;
  /** Safe bottom inset in CSS pixels that keeps content above the keyboard. */
  insetBottom: number;
  /** Current visual viewport width in CSS pixels. */
  viewportWidth: number;
  /** Current visual viewport height in CSS pixels. */
  viewportHeight: number;
}
```

```ts
export function setup(ctx: SpindleFrontendContext) {
  // Read synchronously
  const state = ctx.ui.events.getKeyboardState()

  // Subscribe to changes (returns an unsubscribe function)
  const unsub = ctx.ui.events.onKeyboardChange((newState) => {
    if (newState.visible) {
      console.log(`Keyboard opened. Safe inset bottom: ${newState.insetBottom}px`)
    }
  })
}
```

## Drawer State
Track when the side portrait drawer is opened, closed, or switched to a different tab.

```ts
export interface SpindleUIDrawerState {
  open: boolean;
  tabId: string | null;
}
```

```ts
export function setup(ctx: SpindleFrontendContext) {
  const unsub = ctx.ui.events.onDrawerChange(({ open, tabId }) => {
    if (open && tabId === 'my-extension-tab') {
      console.log('User opened my drawer tab!')
    }
  })
}
```

## Settings State
Track when the settings modal is opened, closed, or switched to a different view.

```ts
export interface SpindleUISettingsState {
  open: boolean;
  view: string;
}
```

```ts
export function setup(ctx: SpindleFrontendContext) {
  const unsub = ctx.ui.events.onSettingsChange(({ open, view }) => {
    if (open && view === 'my-extension-settings') {
      console.log('User opened my extension settings panel!')
    }
  })
}
```

## DOM Action Delegation
`bindActionHandlers` is a helper for binding generic interaction events (click, pointer down, etc.) onto extension-owned DOM, such as elements injected via `ctx.dom.inject()`, mounted via `ctx.ui.mount()`, or returned by `ctx.ui.showModal()`.

Instead of adding dozens of individual `.addEventListener()` calls, you can define a dictionary of action handlers. The helper binds a single delegating event listener to the root container and maps events back to your callbacks.

### Usage

```ts
export function setup(ctx: SpindleFrontendContext) {
  // 1. Create your extension-owned DOM
  const root = ctx.ui.mount('sidebar')
  root.innerHTML = `
    <div id="btn-approve" class="btn">Approve</div>
    <div id="btn-reject" class="btn">Reject</div>
  `

  // 2. Bind action handlers
  // The dictionary keys map to the "id" attribute of descendants by default.
  const unbind = ctx.ui.events.bindActionHandlers(root, {
    'btn-approve': (detail) => {
      console.log('Approved!', detail.element, detail.originalEvent)
    },
    'btn-reject': () => {
      console.log('Rejected!')
    }
  })
}
```

### Advanced Binding
You can override the matching attribute and listen to different pointer events.

```ts
const root = ctx.dom.inject('body', `
  <button data-action="swipe-left">Left</button>
  <button data-action="swipe-right">Right</button>
`)

const unbind = ctx.ui.events.bindActionHandlers(root, {
  'swipe-left': (detail) => { /* ... */ },
  'swipe-right': (detail) => { /* ... */ }
}, {
  attribute: 'data-action',
  events: ['pointerdown', 'pointerup']
})
```

*Note: The target root element must be owned by the calling extension (e.g. marked with `data-spindle-extension-root` internally). The helper will throw an error if you attempt to bind action listeners to system UI or another extension's DOM.*
