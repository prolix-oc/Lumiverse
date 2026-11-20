# Client detection

`ctx.client.getInfo()` reports the client running the current frontend extension. It is synchronous and permission-free, does not prompt or invoke native commands, and returns a frozen snapshot. Read it again when needed to pick up changes in display mode or bridge availability.

Feature-detect both the optional API and the `client-info-v1` host capability for compatibility with older hosts:

```ts
import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

export function setup(ctx: SpindleFrontendContext) {
  if (!ctx.client || !(ctx.host.capabilities['client-info-v1'] >= 1)) return

  const client = ctx.client.getInfo()
  const mobilePwa = client.kind === 'pwa' && client.isMobile
  const mobileApp = client.kind === 'mobile'
  const iosApp = mobileApp && client.platform === 'ios'
  const androidApp = mobileApp && client.platform === 'android'
  const browserTab = client.kind === 'browser'
  const desktopApp = client.kind === 'desktop'

  if (desktopApp && client.bridges.desktop) {
    // Enable UI that depends on a desktop-native transport.
  }
}
```

| Field | Values | Meaning |
|-------|--------|---------|
| `kind` | `browser`, `pwa`, `desktop`, `mobile` | Browser tab, installed web app, native desktop client, or native iOS/Android client |
| `platform` | `ios`, `android`, `macos`, `windows`, `linux`, `unknown` | Native shell identity when available; otherwise best-effort browser OS detection |
| `isMobile` | `boolean` | Mobile device/OS identity, independent of viewport size; true for native mobile apps too |
| `bridges.desktop` | `boolean` | A callable Tauri transport in the native desktop client |
| `bridges.ios` | `boolean` | A supported, callable Lumiverse iOS native bridge |
| `bridges.android` | `boolean` | A callable Tauri transport in the native Android client |

Native shell identity takes precedence over PWA display mode. A browser on an iPhone or Android device stays `browser`; a home-screen PWA is `pwa`; the iOS or Android app is `mobile`. Desktop PWAs also report `pwa`, with `isMobile: false`. A narrow desktop window does not become a mobile client, and iPadOS desktop browser identification is handled using the host's touch-capable Mac signal.

PWAs are recognized through `navigator.standalone` on iOS and the `standalone`, `minimal-ui`, or `window-controls-overlay` display modes. Ordinary browser fullscreen is excluded because it can be entered by a tab through the Fullscreen API. See [MDN's display-mode reference](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/display-mode).

Every bridge flag is false in browsers and PWAs. A native shell can still report a false bridge flag if its transport is missing or unsupported. Bridge presence does not guarantee a specific command, permission, consent, or OS support. Gate native features with their versioned host capability and discovery API too:

```ts
if (ctx.client?.getInfo().bridges.desktop
    && ctx.host.capabilities['system-audio-v1'] >= 1
    && ctx.systemAudio?.isAvailable().available) {
  // Offer system-audio controls. Starting analysis still requires
  // the system_audio permission and the host's consent flow.
}
```

This API describes the current frontend document, including desktop widget windows. The backend server may be on a different machine, and one user may have multiple clients open. Backend extensions can receive this metadata through [frontend communication](backend-communication.md) and its per-document session routing; it must not be used as an authorization signal. Calls after frontend unload throw `SPINDLE_FRONTEND_INACTIVE`.
