# Push Notifications

!!! warning "Permission required: `push_notification`"
    This is a privileged permission. The user must explicitly grant it from the Extensions panel.

Send OS-level push notifications to users' devices. Browser Web Push destinations can receive while the Lumiverse page is closed or backgrounded; native desktop destinations receive while the Lumiverse Desktop companion is running. This is ideal for completed tasks, character activity, or time-sensitive events.

Notifications are automatically **suppressed** on the server when any of the user's connected sessions reports the app as visible. Presence is refreshed after each WebSocket connection and authentication, including PWA resume. User-triggered, per-destination test notifications bypass this suppression so they can be verified from the open Settings page.

Registered destinations may be browser Web Push subscriptions, Lumiverse Desktop native destinations, native iOS APNs destinations, or native Android destinations. The desktop companion's Rust host maintains the notification-only socket and heartbeat independently of its WebViews, then presents the payload through the operating system; it never joins the user's general event channel. iOS receives alert notifications through APNs while backgrounded or closed. The official app uses the encrypted Lumiverse relay by default; self-built IPAs can use their owner's provider credentials. See [iOS notification delivery](../getting-started/ios-notification-relay.md).

Native Android destinations (`android_native`) use a notification-only socket
for the embedded backend and FCM for remote servers. The official APK defaults to
the encrypted Lumiverse FCM relay; operators can build an APK for their own
Firebase project and configure direct delivery. They participate in the same
preferences, presence suppression, destination removal and test flow. Completion
alerts can show the character avatar; error alerts preserve their failure details.
See [Android notification setup](../getting-started/android-notifications.md) for
relay enrollment, APK configuration, provider credentials and local backend lifetime limits.
Android currently renders title, body and owned character avatar thumbnails;
`image` attachments are not rendered. Taps accept `/chat/{id}` and otherwise open
the server's home page.

Native iOS generation Live Activities use a separate, generation-scoped enrollment
and ActivityKit update token. They continue receiving status updates regardless of
ordinary alert preferences or session visibility. Their restricted native token
transport and browser enrollment endpoints are documented in the
[Live Activities integration guide](../getting-started/ios-live-activities-plan.md#backend-enrollment-contract).

Once a push has been sent, the service worker displays it even if the app returns to the foreground before delivery. [WebKit requires every received push to display a notification](https://webkit.org/blog/12945/meet-web-push/); silently discarding it can revoke the subscription.

## Usage

```ts
// Send a push notification
const { sent } = await spindle.push.send({
  title: 'Task Complete',
  body: 'Your character analysis is ready!',
})

spindle.log.info(`Push sent to ${sent} device(s)`)
```

### With Options

```ts
// Tag collapses rapid notifications (same tag = single notification)
await spindle.push.send({
  title: 'New Message',
  body: 'Alice sent you a reply',
  tag: 'chat-update',
  url: '/chat/abc123',      // Where the notification click navigates
})
```

## Methods

### `spindle.push.send(input, userId?)`

Send a push notification to a user's registered devices.

| Parameter | Type | Description |
|---|---|---|
| `input.title` | `string` | Notification title (max 100 chars, auto-prefixed with extension name) |
| `input.body` | `string` | Notification body text (max 500 chars) |
| `input.tag` | `string?` | Dedup key — notifications with the same tag replace each other |
| `input.url` | `string?` | URL to navigate to when the notification is clicked (default: `/`) |
| `input.icon` | `string?` | Relative URL path to an icon image (must start with `/`). Falls back to the app icon. |
| `input.image` | `string?` | Relative URL path to a large image displayed in the notification body (must start with `/`). Works with image gen results: `/api/v1/image-gen/results/{id}?size=lg`. |
| `input.rawTitle` | `boolean?` | When `true`, the title is used as-is without the extension name prefix. |
| `userId` | `string?` | Target user (operator-scoped extensions only; user-scoped infers from owner) |

**Returns:** `Promise<{ sent: number }>` — number of devices the notification was delivered to.

### `spindle.push.getStatus(userId?)`

Check if push notifications are available for a user.

| Parameter | Type | Description |
|---|---|---|
| `userId` | `string?` | Target user (operator-scoped extensions only) |

**Returns:** `Promise<{ available: boolean; subscriptionCount: number }>`

- `available`: `true` if the user has at least one registered browser, desktop, iOS, or Android notification destination
- `subscriptionCount`: number of registered devices

## Attribution

Every push notification title is automatically prefixed with your extension name: **"Your Extension: Your Title"**. This ensures users always know which extension triggered the notification and cannot be spoofed.

Notification titles and bodies are always converted to plain text at dispatch. Formatting tags are removed, block elements and `<br>` become readable line breaks, HTML entities are decoded, and non-visible content such as `<script>` and `<style>` is discarded. Titles are limited to 100 characters and bodies to 500 characters after normalization.

## Checking Before Sending

Always check if push is available before relying on it for critical workflows:

```ts
const status = await spindle.push.getStatus()
if (!status.available) {
  // Fall back to in-app toast
  spindle.toast.info('Task complete! (Enable push notifications for background alerts)')
  return
}

await spindle.push.send({
  title: 'Task Complete',
  body: 'Your analysis is ready',
})
```

## Example: Image Generation + Push Notification

```ts
// Generate an image and send it as a rich push notification
const result = await spindle.imageGen.generate({
  prompt: 'A cozy campfire scene under a starry night sky',
})

if (result.imageUrl) {
  await spindle.push.send({
    title: 'Scene Generated',
    body: 'A new background image is ready',
    image: result.imageUrl,               // large image in notification body
    url: '/gallery',                        // click navigates to gallery
    tag: 'scene-gen',
  })
}
```

The `imageUrl` returned from `spindle.imageGen.generate()` is a public (unauthenticated) relative URL like `/api/v1/image-gen/results/{id}`. You can append `?size=sm` or `?size=lg` for thumbnails:

```ts
image: `${result.imageUrl}?size=lg`   // ~700px thumbnail
```

### Native desktop rich media

The desktop companion downloads `image` in its native Rust host and presents it through the operating system's notification API. If `image` is absent, `icon` is used as a thumbnail attachment. `image` therefore takes precedence when both fields are present.

- PNG, JPEG, and WebP inputs are supported. The companion validates, bounds, resizes, and normalizes them to a cached PNG for consistent native rendering.
- Media URLs must be same-server relative paths. Redirects and cross-origin URLs are rejected.
- Public assets such as image-generation results are fetched directly. User-owned `/api/v1/characters/{id}/avatar` and `/api/v1/images/{id}` assets are resolved through a notification-only authenticated endpoint; the desktop credential is never sent to a general media URL.
- Built-in generation-complete notifications automatically use the chat character's avatar as their thumbnail when one is available.
- An unavailable or invalid image never suppresses the notification: delivery falls back to title and body only.
- The final placement, crop, and size are controlled by macOS, Windows, or the Linux notification daemon. The Lumiverse application identity icon remains unchanged, especially on macOS where it cannot be replaced per notification.

### Native iOS character avatars

Successful built-in chat generation notifications include an APNs communication
sender and a short-lived avatar URL. The signed iOS notification service extension
uses the sender image with `INSendMessageIntent`. iOS controls its presentation;
the application identity remains Lumiverse. Errors and notifications without a
character keep their ordinary alert title and body.

`GET /api/ios-notifications/v1/avatar/{destinationId}/{characterId}?expires={unixSeconds}&signature={hmac}`
returns a bounded JPEG thumbnail for the destination owner's character. This route
does not require a login cookie: its signature grants access only to that exact
destination, character, and expiry (at most 65 minutes). The URL is a bearer
capability and must not be logged or reused as general media authorization.
An invalid, modified, or expired signature returns 401; a deleted destination or
unowned/missing avatar returns 404; an unsupported or oversized image returns 415.
Responses use `Cache-Control: no-store`. The extension rejects redirects and
cross-origin media and falls back to the original alert on download or intent
failure. Existing iOS builds continue receiving ordinary alerts.

## Example: Character "Bugging" the User

```ts
// An extension that makes a character ping the user after inactivity
spindle.on('GENERATION_ENDED', async (payload) => {
  const chatId = payload.chatId

  // Wait 5 minutes, then send a "nudge" push
  setTimeout(async () => {
    const status = await spindle.push.getStatus()
    if (!status.available) return

    await spindle.push.send({
      title: 'Missing You',
      body: 'Hey, are you still there? I was thinking about what you said...',
      tag: `nudge-${chatId}`,
      url: `/chat/${chatId}`,
    })
  }, 5 * 60 * 1000)
})
```

## Example: Background Task Completion

```ts
async function runLongAnalysis(chatId: string) {
  spindle.toast.info('Analysis started — you can close the app, we\'ll notify you when done.')

  // Do expensive work...
  const result = await analyzeChat(chatId)

  // Notify via push (works even if user closed the tab)
  await spindle.push.send({
    title: 'Analysis Complete',
    body: `Found ${result.insights.length} insights across ${result.messagesScanned} messages`,
    tag: `analysis-${chatId}`,
    url: `/chat/${chatId}`,
  })
}
```

!!! tip "Best Practices"
    - Check `getStatus()` before sending — don't assume push is available
    - Use `tag` to avoid notification spam (rapid updates collapse into one)
    - Fall back to `spindle.toast` when push isn't available
    - Keep titles short and bodies actionable
    - Use `url` so clicking the notification takes the user somewhere useful

## Extension Live Activities

For native iOS status, progress and image preview cards, see [Live Activities](live-activities.md). The separate lifecycle API supports encrypted background updates after a foreground start.
