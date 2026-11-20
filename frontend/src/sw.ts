/// <reference lib="webworker" />
import { getSafeInAppNavigationUrl } from './lib/navigationSafety'
import { isCurrentChatNavigation } from './lib/notificationNavigation'
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'
import { CacheFirst, NetworkFirst, NetworkOnly } from 'workbox-strategies'
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
      // Native extension popouts are a separate Vite HTML entry point. Their
      // desktopWidget* query parameters prevent the precache route from
      // matching widget.html exactly, so they must bypass the SPA fallback and
      // reach the server's static-file handler instead of receiving index.html.
      /^\/widget\.html(?:\?.*)?$/,
      /^\/icon(-\d+)?\.(svg|png|ico)$/,
      /\.[a-z0-9]+$/i,
    ],
  }
))

// ── Runtime caching: avatars ────────────────────────────────────────
// Avatar resolver URLs are stable entity routes rather than immutable image
// URLs. Use the network response whenever available so a newly uploaded avatar
// replaces an earlier response at the same URL; retain the cache only as an
// offline fallback. Direct /images/:id assets below remain CacheFirst because
// their image IDs make them immutable.
registerRoute(
  /\/api\/v1\/(characters|personas)\/[^/]+\/avatar/,
  new NetworkFirst({
    cacheName: 'avatar-cache',
    plugins: [new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 7 * 24 * 60 * 60 })],
  })
)

// ── Runtime caching: images ─────────────────────────────────────────
registerRoute(
  ({ url, request }) => (
    url.pathname.startsWith('/api/v1/images/') &&
    request.destination === 'image'
  ),
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

// ── Stream Deck tab handoff ─────────────────────────────────────────
// A service worker can enumerate same-origin windows and navigate the chosen
// client directly. This is more reliable than asking a background page to
// focus itself, which browsers commonly reject without a browser user gesture.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'STREAM_DECK_OPEN_CHAT' || typeof event.data.chatId !== 'string') return

  const reply = event.ports[0]
  const sourceId = event.source && 'id' in event.source ? event.source.id : null
  const path = `/chat/${encodeURIComponent(event.data.chatId)}`

  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clients => {
    const existing = clients.find(client => {
      if (client.id === sourceId) return false
      try {
        const url = new URL(client.url)
        return url.origin === self.location.origin && !url.pathname.startsWith('/stream-deck/open/')
      } catch {
        return false
      }
    })

    if (!existing) {
      reply?.postMessage({ handled: false })
      return
    }

    try {
      const navigated = await existing.navigate(path)
      if (!navigated) throw new Error('Existing client could not be navigated')
      try { await navigated.focus() } catch {}
      reply?.postMessage({ handled: true })
    } catch {
      reply?.postMessage({ handled: false })
    }
  }))
})

// ── Push notification handler ───────────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return

  const payload = event.data.json() as {
    title: string
    body: string
    tag?: string
    data?: {
      url?: string
      chatId?: string
      characterName?: string
      connectionName?: string
      errorCode?: string
      errorMessage?: string
    }
    icon?: string
    image?: string
  }

  // Suppress on the server before sending. Every received push must display
  // a notification to honor userVisibleOnly; silently dropping foreground
  // pushes here causes WebKit to revoke the subscription.
  // https://webkit.org/blog/12945/meet-web-push/
  const showNotification = (async () => {
    await self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon || '/icon-192.png',
      badge: '/icon-192.png',
      tag: payload.tag,
      image: payload.image,
      data: payload.data,
    } as NotificationOptions)

    // Badging is best-effort and must never prevent notification delivery.
    try {
      if ('setAppBadge' in self.navigator) {
        const notifications = await self.registration.getNotifications()
        await (self.navigator as any).setAppBadge?.(notifications.length)
      }
    } catch {
      // Notification permission does not guarantee badging is available.
    }
  })()

  event.waitUntil(showNotification)
})

// ── Notification click handler ──────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  // Clear the badge when user taps a notification
  if ('setAppBadge' in self.navigator) {
    (self.navigator as any).clearAppBadge?.()
  }

  const url = getSafeInAppNavigationUrl(event.notification.data?.url)

  const focusOrOpen = self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then(async (clients) => {
      // Focus an existing app client first. Awaiting focus keeps the service
      // worker alive until the app is foregrounded, which is especially
      // important for a suspended PWA receiving a notification click.
      const appClients = clients.filter((candidate) => {
        try {
          return new URL(candidate.url).origin === self.location.origin
        } catch {
          return false
        }
      })
      const client = appClients.find(candidate => isCurrentChatNavigation(candidate.url, url)) ?? appClients[0]

      if (client) {
        try {
          const focusedClient = await client.focus()
          if (!isCurrentChatNavigation(focusedClient.url, url)) {
            focusedClient.postMessage({ type: 'NAVIGATE', url })
          }
          return
        } catch {
          // A discarded client can still appear in matchAll(). Open a fresh
          // route in that case so the notification always remains actionable.
        }
      }

      await self.clients.openWindow(url)
    })

  event.waitUntil(focusOrOpen)
})


// Manual Blob-backed video wallpaper caching was removed in favor of native
// HTTP/range caching. Delete the old cache so existing installs recover the
// potentially large files it retained on disk.
const OBSOLETE_RUNTIME_CACHES = ['wallpaper-video-cache-v1']

// Take control of clients immediately on activation and clean caches that are
// no longer managed by a current route.
self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    ...OBSOLETE_RUNTIME_CACHES.map((cacheName) => caches.delete(cacheName)),
  ]).then(() => undefined))
})
