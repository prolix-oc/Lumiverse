# Modal

Open a system-themed modal overlay on the user's frontend from the backend. Lumiverse renders the chrome — backdrop, header with title and close button, animations, Escape key handling — and displays structured content items in the body. The call blocks until the user closes the modal.

No permission is required. This is a free-tier utility like [Text Editor](text-editor.md) and [Toast Notifications](toast.md).

For full DOM control over the modal body, use the frontend `ctx.ui.showModal()` API instead — see [UI Placement](../frontend-api/ui-placement.md#modal-free-no-permission-needed).

## Usage

```ts
const result = await spindle.modal.open({
  title: 'Recent Nudges',
  items: [
    { type: 'text', content: 'Here are the last few nudges sent to the user.' },
    { type: 'divider' },
    { type: 'card', items: [
      { type: 'text', content: 'Hey, I noticed you haven\'t been around lately...' },
      { type: 'key_value', label: 'Sent', value: '2 hours ago' },
    ]},
    { type: 'card', items: [
      { type: 'text', content: 'I\'ve been thinking about what you said earlier.' },
      { type: 'key_value', label: 'Sent', value: 'Yesterday' },
    ]},
  ],
})

if (result.dismissedBy === 'user') {
  spindle.log.info('User closed the modal')
}
```

The returned Promise resolves when the modal is dismissed. It never rejects.

### Minimal Call

```ts
const result = await spindle.modal.open({
  title: 'Status',
  items: [
    { type: 'text', content: 'All systems operational.' },
  ],
})
```

## Options

| Field | Type | Default | Description |
|---|---|---|---|
| `title` | `string` | *required* | Title displayed in the modal header |
| `items` | `SpindleModalItemDTO[]` | *required* | Structured body content items rendered by the host (see below) |
| `width` | `number` | `420` | Width in pixels. Clamped to viewport. |
| `maxHeight` | `number` | `520` | Maximum height in pixels. Clamped to viewport. |
| `persistent` | `boolean` | `false` | When `true`, clicking the backdrop does not dismiss the modal. The user must use the close button. |
| `userId` | `string` | — | Target user ID. Only needed for operator-scoped extensions. User-scoped extensions can omit this. |

## Result

| Field | Type | Description |
|---|---|---|
| `dismissedBy` | `'user' \| 'extension' \| 'cleanup'` | How the modal was dismissed. `user` = close button or backdrop click. `extension` = programmatic dismissal. `cleanup` = extension was disabled/unloaded. |

## Content Items

The `items` array accepts a mix of content item types. The host renders them sequentially into the modal body using the system theme.

### `text`

A block of text. Supports multiline content via newlines.

```ts
{ type: 'text', content: 'Hello, world!' }
{ type: 'text', content: 'Muted helper text', muted: true }
```

| Field | Type | Default | Description |
|---|---|---|---|
| `content` | `string` | *required* | Text to display |
| `muted` | `boolean` | `false` | Render in the muted/dim text color |

### `heading`

A section heading within the modal body.

```ts
{ type: 'heading', content: 'Configuration' }
```

| Field | Type | Description |
|---|---|---|
| `content` | `string` | Heading text |

### `divider`

A horizontal separator line. Takes no additional fields.

```ts
{ type: 'divider' }
```

### `key_value`

A label-value pair displayed in a horizontal row — useful for metadata, timestamps, and stats.

```ts
{ type: 'key_value', label: 'Status', value: 'Active' }
{ type: 'key_value', label: 'Last Sent', value: '3 hours ago' }
```

| Field | Type | Description |
|---|---|---|
| `label` | `string` | Left-aligned label text |
| `value` | `string` | Right-aligned value text |

### `card`

A themed container that groups child items. Cards render with a subtle background, border, and border radius matching the system theme. Useful for visually separating repeating entries like history items or list results.

```ts
{
  type: 'card',
  items: [
    { type: 'text', content: 'Hey, where did you go?' },
    { type: 'key_value', label: 'Sent', value: '2 hours ago' },
  ],
}
```

| Field | Type | Description |
|---|---|---|
| `items` | `SpindleModalItemDTO[]` | Child content items rendered inside the card |

Cards can be nested, but keep nesting shallow (1 level) for readability.

## Stack Limit

Extensions may have at most **2 stacked modals** open simultaneously — for example, one modal opened via `spindle.modal.open()` and one text editor opened via `spindle.textEditor.open()`. Attempting to open a third modal rejects with an error.

This limit is enforced per extension. Different extensions can each have their own modals open independently.

## Behavior

- The modal opens as an **overlay** in the Lumiverse frontend, centered on screen with a dimmed backdrop.
- The modal is rendered by the Lumiverse host — it automatically inherits the user's theme, font scale, accent color, and glass mode settings.
- The user can dismiss the modal by clicking the close button, clicking the backdrop (unless `persistent` is `true`), or pressing Escape.
- The call **blocks** until the modal is dismissed. Only one `spindle.modal.open()` call can be pending per extension at a time.
- On mobile, the modal adapts to smaller viewports and is touch-friendly.

## Example: Character Nudge History

```ts
spindle.onFrontendMessage(async (payload, userId) => {
  if (payload.type === 'show_history') {
    const history = await loadNudgeHistory(payload.characterId, userId)
    const character = await spindle.characters.get(payload.characterId, userId)

    const items: import('lumiverse-spindle-types').SpindleModalItemDTO[] = []

    if (history.length === 0) {
      items.push({ type: 'text', content: 'No nudges have been sent yet.', muted: true })
    } else {
      for (const entry of history.reverse()) {
        items.push({
          type: 'card',
          items: [
            { type: 'text', content: entry.text },
            { type: 'key_value', label: 'Sent', value: formatTime(entry.timestamp) },
          ],
        })
      }
    }

    await spindle.modal.open({
      title: `${character?.name ?? 'Character'} — Nudge History`,
      items,
      userId,
    })
  }
})
```

!!! tip "Backend modal vs. frontend modal"
    - **`spindle.modal.open()`** (backend) — use when the backend already has the data and you want a quick structured display without writing any frontend code. The host renders the content items for you.
    - **`ctx.ui.showModal()`** (frontend) — use when you need full DOM control over the modal body: custom layouts, interactive elements, live updates, event handlers.

## Confirmation

Show a system-themed confirmation dialog and wait for the user's response. The host renders a modal with a message, a variant-colored confirm button, and a cancel button.

```ts
const { confirmed } = await spindle.modal.confirm({
  title: 'Clear History',
  message: 'This will delete all nudge history for this character. This action cannot be undone.',
  variant: 'danger',
  confirmLabel: 'Delete',
})

if (confirmed) {
  await clearNudgeHistory(characterId, userId)
  spindle.toast.success('History cleared')
}
```

The returned Promise resolves when the user clicks confirm, clicks cancel, or dismisses the modal. It never rejects. Counts toward the **2 stacked modals** limit per extension.

### Options

| Field | Type | Default | Description |
|---|---|---|---|
| `title` | `string` | *required* | Title displayed in the modal header |
| `message` | `string` | *required* | Body text explaining what the user is confirming |
| `variant` | `'info' \| 'warning' \| 'danger' \| 'success'` | `'info'` | Visual style for the confirm button (see variants below) |
| `confirmLabel` | `string` | `"Confirm"` | Label for the primary action button |
| `cancelLabel` | `string` | `"Cancel"` | Label for the secondary dismiss button |
| `userId` | `string` | — | Target user ID. Only needed for operator-scoped extensions. |

### Result

| Field | Type | Description |
|---|---|---|
| `confirmed` | `boolean` | `true` if the user clicked confirm, `false` if they cancelled or dismissed |

### Variants

The `variant` option controls the confirm button's accent color to signal intent:

| Variant | Button Color | Use For |
|---|---|---|
| `'info'` | Neutral / blue (default) | General confirmations, informational prompts |
| `'warning'` | Yellow / amber | Actions with side effects the user should be aware of |
| `'danger'` | Red | Destructive or irreversible actions (delete, clear, reset) |
| `'success'` | Green | Positive confirmations (enable, activate, approve) |

### Example: Guarding a Destructive Backend Action

```ts
spindle.onFrontendMessage(async (payload, userId) => {
  if (payload.type === 'clear_history') {
    const { confirmed } = await spindle.modal.confirm({
      title: 'Clear Nudge History',
      message: `This will permanently delete all ${payload.count} nudge entries for this character.`,
      variant: 'danger',
      confirmLabel: 'Clear All',
      userId,
    })

    if (confirmed) {
      await spindle.userStorage.setJson(
        `nudge-history/${payload.characterId}.json`,
        [],
        { userId },
      )
      spindle.toast.success('Nudge history cleared')
      spindle.sendToFrontend({ type: 'history_cleared', characterId: payload.characterId }, userId)
    }
  }
})
```

For frontend-initiated confirmations, see [Confirmation Modal](../frontend-api/ui-placement.md#confirmation-modal-free-no-permission-needed) in the Frontend API docs.

---

## Input Prompt

Present a text input modal to the user and wait for their response. The host renders a themed dialog with a title, optional message, a text input (single-line or multiline), and submit/cancel buttons. The call blocks until the user submits or cancels.

```ts
const { value, cancelled } = await spindle.prompt.input({
  title: 'Rename Preset',
  placeholder: 'Enter a name...',
  defaultValue: currentName,
})

if (!cancelled && value) {
  await renamePreset(value)
  spindle.toast.success(`Renamed to "${value}"`)
}
```

The returned Promise resolves when the user submits or cancels. It never rejects. Counts toward the **2 stacked modals** limit per extension.

### Options

| Field | Type | Default | Description |
|---|---|---|---|
| `title` | `string` | *required* | Title displayed in the modal header |
| `message` | `string` | — | Description shown below the title |
| `placeholder` | `string` | — | Placeholder text for the input field |
| `defaultValue` | `string` | `""` | Pre-filled value |
| `submitLabel` | `string` | `"Submit"` | Label for the primary action button |
| `cancelLabel` | `string` | `"Cancel"` | Label for the dismiss button |
| `multiline` | `boolean` | `false` | Render a multi-line textarea instead of a single-line input |
| `userId` | `string` | — | Target user ID. Only needed for operator-scoped extensions. |

### Result

| Field | Type | Description |
|---|---|---|
| `value` | `string \| null` | The submitted text, or `null` if the user cancelled |
| `cancelled` | `boolean` | `true` if the user cancelled or dismissed the prompt |

### Behavior

- The input auto-focuses when the modal opens.
- **Single-line** (`multiline: false`): pressing Enter submits. Ctrl/Cmd+Enter also submits.
- **Multi-line** (`multiline: true`): Enter inserts a newline. Ctrl/Cmd+Enter submits.
- The submit button is disabled until the input has non-whitespace content.
- The modal can be dismissed by clicking cancel, clicking the backdrop, or pressing Escape — all of these resolve with `cancelled: true`.

### Example: Collecting Feedback Before an Action

```ts
spindle.commands.register([{
  id: 'send-feedback',
  label: 'Send Feedback to Character',
  scope: 'chat',
}])

spindle.commands.onInvoked(async (commandId, context) => {
  if (commandId !== 'send-feedback') return

  const { value, cancelled } = await spindle.prompt.input({
    title: 'Character Feedback',
    message: 'This will be injected as an OOC instruction in the next generation.',
    placeholder: 'e.g. Be more descriptive, focus on the environment...',
    multiline: true,
    submitLabel: 'Send',
  })

  if (cancelled || !value) return

  // Store feedback for the next generation cycle
  await spindle.variables.local.set(context.chatId!, 'pending_feedback', value)
  spindle.toast.info('Feedback queued for next generation')
})
```

### Example: Single-Line Rename

```ts
const { value } = await spindle.prompt.input({
  title: 'Rename Profile',
  defaultValue: profile.name,
  placeholder: 'Profile name',
  submitLabel: 'Rename',
})

if (value) {
  profile.name = value
  await saveProfile(profile)
}
```
