---
title: Notifications
---

# Notifications

Lumiverse can send system notifications to your devices when certain events happen — like when a character finishes responding. This is useful when you're multitasking, using the PWA on mobile, or running Lumiverse Desktop.

---

!!! warning "HTTPS or localhost required in a browser"
    Browser push notifications rely on Service Workers, which most browsers only allow in **secure contexts**. This means browser delivery will only work when accessing Lumiverse via:

    - **`localhost`** — Always treated as secure, even without SSL
    - **HTTPS** — A reverse proxy with a valid SSL certificate (e.g., `https://lumiverse.example.com`)

    If you're accessing Lumiverse in a browser over plain HTTP on a remote IP (e.g., `http://192.168.1.50:7860`), browser push will not be available. Lumiverse Desktop uses its native notification bridge instead of Service Worker push.

## Setting Up

1. Open **Settings > Notifications**
2. Toggle **Enable push notifications**
3. Click **Enable** for this device (your browser or operating system will ask for notification permission)
4. Grant permission when prompted

Each device must be subscribed individually. You can manage all your registered devices from this settings tab.

Lumiverse Desktop registers as a native destination. Its device identity and revocable enrollment credential are stored in the operating system's per-app configuration directory, so rebuilding or updating the desktop bundle does not require you to sign in again just to keep receiving notifications. The credential is pinned to that server's origin and identity; removing the destination in Settings revokes it.

The iOS app uses Apple's native push service (APNs), so it does not require
browser Push API support. It needs an IPA signed with the Push Notifications
capability. The official app uses the Lumiverse notification relay, automatically
verifies the device, and encrypts notification previews between your backend and
your iPhone. A one-time connection alert may appear while enabling notifications.
Self-built IPAs can use their owner's Apple provider credentials on the backend. Free
Personal Team signing cannot enable APNs; the iOS notification settings show
missing app or server configuration. Once configured, notifications can arrive
while the app is backgrounded or closed.

If iOS cannot decrypt a preview, it shows a generic Lumiverse alert. The relay
sees delivery metadata and generic Live Activity progress. Enable notifications
on this iPhone before using Live Activities through the relay.

The Android app also registers a native destination. Completion alerts can show
the character's avatar; failure alerts show the connection and error details.
Tapping an alert opens its chat on the enrolled server. Android 13 and later ask
for notification permission, and Android's app settings offer separate channels
for completion and error alerts.

When hosting on the phone, native notifications work while the embedded backend
is running. When connected to a remote server, both the APK and server need
matching Firebase configuration. Settings reports missing configuration before
enrollment. Force-stopping the app prevents remote delivery until it is reopened;
notifications do not keep an on-device generation running after Android stops the
backend. Changing servers or signing out clears the app's native enrollment.

---

## Notification Events

| Event | Notification |
|-------|-------------|
| **Generation completed** | Character name as title, first 120 characters of the response as body |
| **Generation failed** | Connection name in the title, with the error code and message in the body |

Each event type can be enabled or disabled independently.

---

## Visibility Gating

Automatic notifications are **suppressed when you're actively viewing the app on any connected device**. For example, keeping Lumiverse visible on your laptop suppresses notifications to your phone. They resume when all connected sessions are hidden or closed.

The per-device **test notification** deliberately bypasses this visibility check so you can verify delivery while the Settings page is open.

A notification already sent while you were away may still arrive just after you reopen the app.

---

## Device Management

From the Notifications settings tab:

- View all registered devices
- Remove individual device subscriptions
- Send a **test notification** to verify everything works

Browser subscriptions that stop accepting notifications are automatically cleaned up. A desktop destination can be removed from Settings to revoke its durable credential.

---

## Tips

!!! tip "Great for mobile PWA"
    Add Lumiverse to your home screen and enable notifications. You'll get alerts when the AI responds, even when the app is in the background.

!!! tip "Use with long generations"
    If you're using a slow model or generating very long responses, notifications let you switch to other tasks and come back when the response is ready.
