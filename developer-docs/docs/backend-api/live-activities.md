# Live Activities

Permission required: `push_notification` (the user grants this in the Extensions panel).

`spindle.liveActivities` provides three built-in layouts in the native iOS app. Activities can continue receiving encrypted status updates while the app is backgrounded. This first version queues new activities until an enrolled iOS app is open with Live Activities enabled; `remoteStart` is `false`. It does not start a new activity on a closed app.

| Layout | Required fields | Presentation |
|---|---|---|
| `status` | `title` | Symbol, title, and optional body |
| `progress` | `title`, `progress` | Status content plus a progress bar; progress is a fraction from 0 to 1 |
| `image` | `title`, `imageId` | Small preview of a user-owned image, title, and optional body |

All layouts also accept `body` and an optional SF Symbol name in `symbol`. The native app supplies Lock Screen, expanded, compact and minimal Dynamic Island presentations. Text is normalized to plain text and limited to 80 title characters and 160 body characters. Images are compressed to a tiny static thumbnail; complex images can fall back to a photo placeholder to preserve the payload budget. Arbitrary image URLs, HTML, CSS and native code are not accepted.

```ts
const status = await spindle.liveActivities.getStatus()
if (!status.available) {
  spindle.log.info('Open an updated iOS app and enable notifications and Live Activities first.')
  return
}

const activity = await spindle.liveActivities.start({
  key: 'analysis-job-123',
  layout: 'status',
  title: 'Preparing analysis',
  body: 'Collecting the source material',
  symbol: 'doc.text.magnifyingglass',
  durationSeconds: 3600,
})

await spindle.liveActivities.update(activity.id, {
  layout: 'progress',
  title: 'Analyzing material',
  progress: 0.65,
})

// imageId must identify an image owned by the target user in Lumiverse's image store.
await spindle.liveActivities.update(activity.id, {
  layout: 'image',
  title: 'Illustration ready',
  imageId: savedImage.id,
})
await spindle.liveActivities.end(activity.id)
```

## Methods

- `getStatus(userId?)` returns `{ available, layouts, remoteStart: false, enrolledDevices }`. Availability means a supporting iOS installation has enrolled, rather than a guarantee that iOS will display every request.
- `start(input, userId?)` accepts a layout presentation, a required `key`, and optional `durationSeconds` (60–28,800, default 3,600). The key contains 1–128 letters, digits, underscores or hyphens. It is idempotent within the extension/user: repeated calls return the same activity, including after it ends. Use a new key for a new task.
- `update(id, presentation, userId?)` replaces the entire presentation. The layout may change. Omitted optional fields do not retain their prior values. Ended activities cannot be updated.
- `end(id, userId?)` ends the activity using the latest presentation. The final card can remain briefly on the Lock Screen. Repeated calls are safe.

Lifecycle methods return `{ id, revision, state }`, where `state` is `queued`, `active`, or `ended`. `active` means native activity/token enrollment has occurred; it is not a display or push-delivery receipt. Background updates are coalesced and retried and remain subject to iOS delivery policy. Content becomes stale if no update arrives within five minutes.

User-scoped extensions infer the owner. Operator-scoped extensions must supply the target `userId` using the existing scoped-user rules. An extension cannot update or end another extension's activities. At most 16 unexpired tasks are retained per account. Disabling the extension or revoking its notification permission ends its tasks. Dismissing a card suppresses that task on that device. Turning off the native Live Activities preference stops delivery to the installation.

Custom title/body/progress/thumbnail data is encrypted for each activity registration, including when using the Lumiverse APNs relay. The native app supplies a registration-scoped rendering key locally to ActivityKit; that key is never sent to the relay. Extension attribution remains visible. Native update tokens and relay credentials are not exposed through the Spindle API.

This API requires a backend, iOS app, relay and Spindle types package containing the templates protocol. Publish/update those components together before distributing an extension that requires it. Older iOS apps do not report template support and will not enroll. Existing built-in generation activities retain their current protocol.

Use [push notifications](push-notifications.md) for separate completion alerts. Activity updates in this version are silent, and ordinary notification presence suppression does not stop an already enrolled activity's status updates. Large rich image attachments are separate from the small preview supported here.
