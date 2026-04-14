/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'
import { CacheFirst, NetworkOnly } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { BackgroundSyncPlugin } from 'workbox-background-sync'

declare let self: ServiceWorkerGlobalScope

// ── Immediately activate new service workers ──────────────────────────
// Skip the waiting phase so updates take effect without requiring all
// tabs to close. Combined with clients.claim() on activate, this ensures
// a rebuild is picked up on the next navigation or periodic check.
self.addEventListener('install', () => { self.skipWaiting() })

// ── Precaching (injected by vite-plugin-pwa at build time) ──────────
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// ── SPA navigation fallback ─────────────────────────────────────────
// NavigationRoute only matches requests with mode: 'navigate', but certain
// top-level fetches (direct URL-bar loads, PWA install-prompt manifest
// probes, and older stale SW installs) can route non-SPA paths through this
// handler and end up serving index.html for assets — which causes Chrome
// to report "Manifest: manifest.json:1 col:1 Syntax error" when HTML is
// returned for the manifest fetch. Explicitly exclude known static assets
// and file-extension paths so the SW never hijacks them.
registerRoute(new NavigationRoute(
  createHandlerBoundToURL('index.html'),
  {
    denylist: [
      /^\/api/,
      /^\/uploads/,
      /^\/manifest\.json$/,
      /^\/sw\.js$/,
      /^\/icon(-\d+)?\.(svg|png|ico)$/,
      /\.[a-z0-9]+$/i,
    ],
  }
))

// ── Runtime caching: avatars ────────────────────────────────────────
registerRoute(
  /\/api\/v1\/(characters|personas)\/[^/]+\/avatar/,
  new CacheFirst({
    cacheName: 'avatar-cache',
    plugins: [new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 7 * 24 * 60 * 60 })],
  })
)

// ── Runtime caching: images ─────────────────────────────────────────
registerRoute(
  /\/api\/v1\/images\//,
  new CacheFirst({
    cacheName: 'image-cache',
    plugins: [new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 7 * 24 * 60 * 60 })],
  })
)

// ── Background Sync: messages ───────────────────────────────────────
registerRoute(
  /\/api\/v1\/chats\/.+\/messages/,
  new NetworkOnly({
    plugins: [new BackgroundSyncPlugin('lumiverse-messages', { maxRetentionTime: 24 * 60 })],
  }),
  'POST'
)

registerRoute(
  /\/api\/v1\/chats\/.+\/messages/,
  new NetworkOnly({
    plugins: [new BackgroundSyncPlugin('lumiverse-messages-put', { maxRetentionTime: 24 * 60 })],
  }),
  'PUT'
)

// ── Background Sync: settings ───────────────────────────────────────
registerRoute(
  /\/api\/v1\/settings/,
  new NetworkOnly({
    plugins: [new BackgroundSyncPlugin('lumiverse-settings', { maxRetentionTime: 24 * 60 })],
  }),
  'PUT'
)

// ── Background Sync: characters ─────────────────────────────────────
registerRoute(
  /\/api\/v1\/characters/,
  new NetworkOnly({
    plugins: [new BackgroundSyncPlugin('lumiverse-characters', { maxRetentionTime: 24 * 60 })],
  }),
  'PUT'
)

// ── Push notification handler ───────────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return

  const payload = event.data.json() as {
    title: string
    body: string
    tag?: string
    data?: { url?: string; chatId?: string; characterName?: string }
    icon?: string
    image?: string
  }

  // Suppress if user is actively looking at the app (WS handles in-app)
  const showNotification = self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then(async (clients) => {
      const hasFocusedClient = clients.some(
        (c) => c.visibilityState === 'visible' && c.focused
      )
      if (hasFocusedClient) {
        // Clear badge when user is actively viewing the app
        if ('setAppBadge' in self.navigator) {
          (self.navigator as any).clearAppBadge?.()
        }
        return
      }

      // Increment badge count on the PWA home screen icon
      if ('setAppBadge' in self.navigator) {
        // Get current notification count to use as badge
        const notifications = await self.registration.getNotifications()
        const count = notifications.length + 1
        ;(self.navigator as any).setAppBadge?.(count)
      }

      return self.registration.showNotification(payload.title, {
        body: payload.body,
        icon: payload.icon || '/icon-192.png',
        badge: '/icon-192.png',
        tag: payload.tag,
        image: payload.image,
        data: payload.data,
      } as NotificationOptions)
    })

  event.waitUntil(showNotification)
})

// ── Notification click handler ──────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  // Clear the badge when user taps a notification
  if ('setAppBadge' in self.navigator) {
    (self.navigator as any).clearAppBadge?.()
  }

  const url = event.notification.data?.url || '/'

  const focusOrOpen = self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((clients) => {
      // Try to find an existing Lumiverse tab
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          client.focus()
          client.postMessage({ type: 'NAVIGATE', url })
          return
        }
      }
      return self.clients.openWindow(url)
    })

  event.waitUntil(focusOrOpen)
})


// Take control of clients immediately on activation
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})
