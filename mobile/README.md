# Lumiverse Android companion

A small native WebView client for an existing Lumiverse server. Android volume
buttons can page through the chat without touching the screen. This is a separate
mobile client, not a port of the desktop tray or its local server runner.

## Use

1. Install the debug APK from the **Build Android companion** workflow artifact.
2. Enter your Lumiverse server address once, then sign in using the web UI.
3. Lumiverse fills the app with no native toolbar or on-screen paging buttons.
   Volume Up pages up and Volume Down pages down, enabled by default.
   Each press moves 85% of the visible chat height. Holding a button does not repeat.
4. Android Back navigates browser history. At the root it offers connection
   settings and Close app. Connection settings can change the server or disable
   volume paging to restore normal volume controls. Preferences are saved.

Connection failures show a dialog with Retry and Change server, rather than
leaving an unexplained blank screen. A loading spinner appears during navigation.

Paging targets the visible `data-chat-scroll` container already present in
Lumiverse. It does nothing while a visible dialog is open or no chat is visible.
Composer focus does not block hardware paging, even after the keyboard closes. While volume paging is enabled on a loaded server, volume
buttons are consumed even when paging does nothing. Disable volume paging in connection settings to adjust
audio, including during TTS playback. Background volume controls are unaffected.

The companion uses the chat's existing wheel handler to stop automatic following
before scrolling. Paging needs no server update. TLS errors are never bypassed;
HTTPS requires a valid certificate trusted by Android. Private IPv4 addresses, including
100.64.0.0/10 VPN addresses, default to HTTP when no scheme is entered. Other
addresses default to HTTPS. An explicit http:// or https:// always takes precedence.
HTTP has no TLS encryption; use it over a trusted connection such as your VPN.
Web content has no JavaScript-to-native bridge and no file access. Links outside
the selected origin open in the system browser when explicitly tapped.

Sign-in uses the WebView cookie store, separate from Chrome and Lumiverse Desktop.
External identity-provider flows that require browser callbacks are not implemented.
File uploads, downloads, notifications, floating widgets and local server management
are not included in this initial reading companion. Android WebView renders the
server's current frontend, so frontend updates arrive from your server.

## Build

Requires JDK 17 and Android SDK platform/build tools 35. The Gradle wrapper pins
Gradle 8.11.1 and the Android Gradle plugin is pinned to 8.9.2.

```sh
bun test mobile/tests/page.test.ts
cd mobile/android
# Set ANDROID_HOME, or set sdk.dir in an untracked local.properties.
./gradlew assembleDebug lintDebug testDebugUnitTest
```

On Windows use `gradlew.bat`. The installable, development-signed APK is at
`app/build/outputs/apk/debug/app-debug.apk`. This is a test build, not a Play Store
release. A release needs a maintained signing key; CI debug keys can change
between builds, requiring uninstalling an older test build before reinstalling.

## Device verification

Before merging, test on a physical Android phone:

- Connect, sign in, restart the app, and verify session persistence.
- Page a long chat in both directions, including while a response is streaming.
- Confirm 15% overlap, no repeated paging when held, and loading older history.
- Keep the composer focused after closing the keyboard and verify paging works.
- Open a modal and verify the chat behind it does not move.
- Turn volume paging off and test media volume; test it with the app backgrounded.
- Rotate the device and check system bars, keyboard insets and the controls.
- Verify external links open in the browser and invalid TLS is rejected.

The automated paging tests cover direction, visible viewport height, and guards.
They do not replace device testing of hardware buttons and WebView integration.
