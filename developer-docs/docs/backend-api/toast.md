# Toast Notifications

Show native toast notifications in the Lumiverse frontend. Toasts appear as temporary pop-up messages — useful for confirming actions, reporting errors, or surfacing status updates to the user.

No permission is required. This is a free-tier utility like [Logging](logging.md).

## Usage

```ts
spindle.toast.success('Character imported!')
spindle.toast.warning('API rate limit approaching')
spindle.toast.error('Failed to connect to external service')
spindle.toast.info('Processing complete — 42 entries updated')
```

### With Options

```ts
// Custom title
spindle.toast.success('All changes saved', {
  title: 'Auto-Save',
})

// Custom duration (milliseconds)
spindle.toast.info('Syncing data...', {
  duration: 10000,  // 10 seconds
})

// Both
spindle.toast.error('Connection timed out', {
  title: 'Network Error',
  duration: 12000,
})
```

## Methods

| Method | Description |
|---|---|
| `spindle.toast.success(message, options?)` | Green success notification |
| `spindle.toast.warning(message, options?)` | Yellow warning notification |
| `spindle.toast.error(message, options?)` | Red error notification |
| `spindle.toast.info(message, options?)` | Blue informational notification |

All methods are **fire-and-forget** — they return `void`, not a Promise. The toast is displayed asynchronously in the frontend.

## Options

| Field | Type | Description |
|---|---|---|
| `title` | `string` | Custom title shown above the message |
| `duration` | `number` | Display time in milliseconds (clamped to 1,000–30,000ms) |

If no `duration` is provided, the frontend uses its defaults: 4s for success, 5s for info, 6s for warning, 8s for error.

## Attribution

Every toast is automatically prefixed with your extension's name (from `spindle.json`). Users always know which extension triggered the notification.

- No custom title: toast title shows **"Your Extension Name"**
- With custom title: toast title shows **"Your Extension Name: Your Title"**

The extension name is set by the host from your manifest and cannot be spoofed.

## Rate Limiting

Toasts are rate-limited to **5 per 10 seconds** per extension. If you exceed the limit, additional toasts are silently dropped (a warning is logged to the server console). The limit uses a sliding window — once older toasts age out of the 10-second window, new ones are accepted again.

!!! tip "Best practices"
    - Use toasts for user-facing feedback, not debugging — use `spindle.log` for that
    - Keep messages short and actionable
    - Prefer `success` and `info` for routine confirmations; reserve `error` for real failures
    - Don't spam toasts in loops — batch results into a single message

## Example: Operation Feedback

```ts
try {
  const result = await doExpensiveOperation()
  spindle.toast.success(`Processed ${result.count} items`, {
    title: 'Batch Complete',
  })
} catch (err) {
  spindle.toast.error(err.message, {
    title: 'Operation Failed',
    duration: 10000,
  })
}
```
