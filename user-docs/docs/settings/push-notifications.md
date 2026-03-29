# Push Notifications

Lumiverse can send push notifications to your devices when certain events happen — like when a character finishes responding. This is useful when you're multitasking or using the PWA on mobile.

---

!!! warning "HTTPS or localhost required"
    Push notifications rely on Service Workers, which most browsers only allow in **secure contexts**. This means they will only work when accessing Lumiverse via:

    - **`localhost`** — Always treated as secure, even without SSL
    - **HTTPS** — A reverse proxy with a valid SSL certificate (e.g., `https://lumiverse.example.com`)

    If you're accessing Lumiverse over plain HTTP on a remote IP (e.g., `http://192.168.1.50:7860`), push notifications will not be available. The browser silently disables Service Worker registration in insecure remote contexts.

## Setting Up

1. Open **Settings > Notifications**
2. Toggle **Enable push notifications**
3. Click **Enable** for this device (your browser will ask for notification permission)
4. Grant permission when prompted

Each device must be subscribed individually. You can manage all your registered devices from this settings tab.

---

## Notification Events

| Event | Notification |
|-------|-------------|
| **Generation completed** | Character name as title, first 120 characters of the response as body |
| **Generation failed** | "Generation Failed" as title, error message as body |

Each event type can be enabled or disabled independently.

---

## Visibility Gating

Notifications are **suppressed when you're actively viewing the app**. They only fire when you're in another tab, have the window minimized, or are on a different app. This prevents redundant notifications for events you're already watching.

---

## Device Management

From the Notifications settings tab:

- View all registered devices
- Remove individual device subscriptions
- Send a **test notification** to verify everything works

Devices that stop accepting notifications (uninstalled browser, cleared data) are automatically cleaned up.

---

## Tips

!!! tip "Great for mobile PWA"
    Add Lumiverse to your home screen and enable notifications. You'll get alerts when the AI responds, even when the app is in the background.

!!! tip "Use with long generations"
    If you're using a slow model or generating very long responses, notifications let you switch to other tasks and come back when the response is ready.
