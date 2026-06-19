# UI Automation

Enumerate and drive Lumiverse's built-in navigation surfaces — drawer tabs, settings tabs, and the command palette — from your backend worker. Same primitives the Command Palette uses, but exposed to extensions so agents and onboarding flows can steer the user to the right surface.

No permission is required. This is a free-tier utility like [Toast Notifications](toast.md).

## Quick Start

```ts
// List what's available
const drawerTabs = await spindle.ui.getDrawerTabs({ userId })
const settingsTabs = await spindle.ui.getSettingsTabs({ userId })

// Take the user straight to a tab
await spindle.ui.openDrawerTab('connections', { userId })

// Open settings on a specific view
await spindle.ui.openSettings('webSearch', { userId })

// Surface the command palette
await spindle.ui.openCommandPalette({ userId })
```

## When to use

- **Onboarding flows** — an extension that needs an API key can open the **Connections** drawer for the user instead of telling them to find it.
- **AI agents** — a Lumia member can navigate the user to a setting it's about to ask them to change, or surface a relevant panel for context.
- **Custom command palettes** — pair `getDrawerTabs()` + `getSettingsTabs()` with [`spindle.modal.open()`](modal.md) to build your own searchable picker that targets the same surfaces.

For *adding* command palette entries (rather than navigating to existing ones), see [Commands](commands.md).

## Methods

### `spindle.ui.getDrawerTabs(options?)`

Read the drawer tabs visible to the resolved user. Returns built-in tabs and any extension-contributed tabs the user's frontend has registered.

```ts
const tabs = await spindle.ui.getDrawerTabs({ userId })
// [
//   { id: 'profile',     shortName: 'Profile', tabName: 'Profile', ..., source: 'builtin' },
//   { id: 'connections', shortName: 'Connect', tabName: 'Connections', ..., source: 'builtin' },
//   { id: 'my-ext-tab',  tabName: 'My Panel', ..., source: 'extension', extensionId: 'com.acme.tools' },
//   ...
// ]
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Stable id used by `openDrawerTab(id)` |
| `shortName` | `string` | Short label under the sidebar icon (max ~8 chars) |
| `tabName` | `string` | Full title shown in menus and the command palette |
| `tabDescription` | `string` | One-line description |
| `keywords` | `string[]` | Search keywords used by the command palette |
| `source` | `'builtin' \| 'extension'` | Origin of the tab |
| `extensionId` | `string?` | Set when `source === 'extension'` |

!!! note "Extension tabs may lag"
    Extension drawer tabs are synced from the user's frontend over the WebSocket. While a fresh tab loads, the snapshot may briefly show only built-ins. Built-in tabs are always present.

### `spindle.ui.getSettingsTabs(options?)`

Read the settings tabs visible to the resolved user. Restricted tabs (`role: 'admin'` or `'owner'`) are filtered to match the user's role.

```ts
const tabs = await spindle.ui.getSettingsTabs({ userId })
// [
//   { id: 'account',     tabName: 'Account Settings',  ... },
//   { id: 'display',     tabName: 'Display & Layout',  ... },
//   { id: 'webSearch',   tabName: 'Web Search',        ... },
//   { id: 'operator',    tabName: 'Operator Panel', role: 'owner', ... },  // owners only
//   ...
// ]
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Stable id used by `openSettings(id)` |
| `shortName` | `string` | Short label shown in the settings sidebar |
| `tabName` | `string` | Full title shown in the header and command palette |
| `tabDescription` | `string` | One-line description |
| `keywords` | `string[]` | Search keywords used by the command palette |
| `role` | `'admin' \| 'owner'?` | Present when the tab is role-gated |

### `spindle.ui.openDrawerTab(tabId, options?)`

Open the drawer to a specific tab. The id is forwarded verbatim, so extension-contributed tab ids (anything reported by `getDrawerTabs()`) work just as well as built-ins.

```ts
await spindle.ui.openDrawerTab('lorebook', { userId })
```

If the drawer is already open it just switches tabs. Resolves once the navigation event is dispatched — the frontend applies it asynchronously.

### `spindle.ui.closeDrawer(options?)`

Close the drawer if it is currently open.

```ts
await spindle.ui.closeDrawer({ userId })
```

### `spindle.ui.openSettings(viewId?, options?)`

Open the settings modal and switch to the specified tab in a single step.

```ts
// Land on the Connections settings tab
await spindle.ui.openSettings('webSearch', { userId })

// Open settings (falls back to the 'display' tab when no view id is supplied)
await spindle.ui.openSettings(undefined, { userId })
```

If you pass an unknown id, the frontend still flips the modal open with that id as the active view; the picker will simply not match a known tab.

### `spindle.ui.closeSettings(options?)`

Close the settings modal if it is currently open.

```ts
await spindle.ui.closeSettings({ userId })
```

### `spindle.ui.openCommandPalette(options?)` / `spindle.ui.closeCommandPalette(options?)`

Show or hide the command palette overlay (the same surface as Cmd/Ctrl+K).

```ts
await spindle.ui.openCommandPalette({ userId })
```

## User scoping

`options.userId` follows the standard Spindle scoping rules — same as [Toast Notifications](toast.md) and [Modal](modal.md):

- **User-scoped extensions:** `userId` is inferred from the installer and the option is ignored.
- **Operator-scoped extensions:** pass the `userId` from the event/handler that triggered the navigation (e.g. the `userId` argument on an `onFrontendMessage` callback). Omitting `userId` on an operator-scoped extension is allowed but broadcasts navigation events to **every connected user**, which is rarely what you want.

For `getDrawerTabs()` / `getSettingsTabs()`, omitting `userId` returns:

- Drawer tabs: built-ins only (no per-user extension tab data is loaded).
- Settings tabs: every tab including role-gated entries, since role gating cannot be applied without a user.

## Patterns

### Onboarding nudge

```ts
spindle.on('CHAT_CHANGED', async (_, userId) => {
  const connections = await spindle.connections.list(userId)
  if (connections.length === 0) {
    spindle.toast.info('No API connection configured yet — opening Connections.', { userId })
    await spindle.ui.openDrawerTab('connections', { userId })
  }
})
```

### Build a custom picker

```ts
const tabs = await spindle.ui.getDrawerTabs({ userId })

const { dismissedBy, openRequestId } = await spindle.modal.open({
  title: 'Jump to…',
  items: tabs.map((t) => ({
    type: 'key_value',
    label: t.tabName,
    value: t.tabDescription,
  })),
  userId,
})

if (dismissedBy === 'user') {
  // (Real implementations would render selectable buttons via a custom widget.)
}
```

### Agent-driven setting walkthrough

```ts
async function walkUserTo(viewId: string, userId: string, hint: string) {
  spindle.toast.info(hint, { userId, duration: 8_000 })
  await spindle.ui.openSettings(viewId, { userId })
}

await walkUserTo(
  'webSearch',
  userId,
  'Set your SearXNG URL here, then re-run the council tool.',
)
```

## Behavior notes

- Navigation calls are **fire-and-forget** from the frontend's perspective. The returned promise resolves once the host has dispatched the event, not when the UI animation completes.
- Unknown `tabId` / `viewId` values won't throw. The drawer/settings modal still toggles open and the unknown id sits as the active view — useful while iterating, but worth guarding against in production code.
- Navigation events are scoped through the WebSocket bus, so an open palette / drawer / settings modal on **another** device for the same user will also react.
- There is no rate limit on navigation calls, but stacking many opens in quick succession will simply land the user on whatever tab the last call requested.
