# Lumiverse Desktop (Experimental)

An experimental Tauri-powered Lumiverse desktop app for macOS, Windows, and
Linux. It opens Lumiverse in an integrated native WebView and keeps a tray
icon available for server controls, status, and updates.

The integrated browser is the primary experience: when Lumiverse Desktop starts
its local server, it opens the native Lumiverse window. The tray menu can hide,
reopen, or reload that window, and can still open the same address in your
default browser when needed.

Under the hood it spawns the existing runner in a headless mode
(`bun scripts/runner.ts --headless`) and drives it over stdio with the same
message shapes the web Operator panel uses. No extra ports or sockets are
opened; when the tray app exits, the runner sees its stdin close and shuts
the server down gracefully.

## Menu

- **Status line** — running / stopped / starting / crashed, or
  "running (external)" when a server started from a terminal is detected
  on the configured port.
- **Start Server / Stop Server**
- **Open Lumiverse** — opens or closes the integrated Tauri browser. Its
  submenu also reloads it or opens the current address in your default browser.
- **Floating Widgets** — lists live extension widgets registered by Lumiverse
  (for example, SpotifyControls). Selecting one starts that extension in a
  widget-only native window. The menu also retains the native POC,
  including its click-through test.
- **Serving Stats** — port, PID, uptime, branch, version.
- **Check for Updates / Apply Update** — the runner's existing git-based
  update flow.
- **Start Server at Launch** — start the server automatically when the
  tray app opens (on by default).
- **Launch at Login** — register the tray app as a login item.
- **Set Lumiverse Folder…** — point the app at a different checkout.

## Translucent frontend themes

The Tauri frontend window is transparent, so a theme can tint the document
with an alpha color and optionally request the native material behind it:

```json
{
  "desktopBackground": {
    "color": "rgb(16 12 28 / 72%)",
    "blur": true
  }
}
```

`blur` uses macOS vibrancy and Windows DWM blur. On other platforms, or when
native material is unavailable, the theme keeps its regular translucent CSS
surface. Browser and PWA rendering ignore this desktop-only setting.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3.13 (also required by the server itself)
- [Rust](https://rustup.rs) stable (Tauri v2 builds the native shell)

Platform-specific requirements:

- **macOS:** Xcode Command Line Tools.
- **Windows:** WebView2 Runtime (preinstalled on Windows 11) and the MSVC
  build tools.
- **Linux:** GTK/WebKitGTK development libraries plus an AppIndicator
  implementation. The helper publishes its tray icon through the
  StatusNotifierItem/AppIndicator D-Bus protocol.

  Debian/Ubuntu:

  ```bash
  sudo apt install build-essential curl wget file libssl-dev \
    libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
    librsvg2-dev libxdo-dev
  ```

  Fedora:

  ```bash
  sudo dnf install gcc gcc-c++ make curl wget file openssl-devel \
    webkit2gtk4.1-devel libappindicator-gtk3-devel \
    librsvg2-devel libxdo-devel
  ```

  Arch Linux:

  ```bash
  sudo pacman -S --needed base-devel curl wget file openssl \
    webkit2gtk-4.1 libappindicator-gtk3 librsvg libxdo
  ```

  Package names vary by distribution. `libayatana-appindicator3-dev` may be
  substituted with the distribution's `libappindicator` development package.
  These are build dependencies; a machine running an unpackaged Linux binary
  also needs the matching AppIndicator runtime library.

  KDE Plasma exposes StatusNotifier items natively. GNOME Shell does not show
  them by default, so install and enable an AppIndicator/KStatusNotifier
  extension (for example, **AppIndicator and KStatusNotifierItem Support**).

## Develop

```bash
cd desktop
bun install
bun run tauri dev
```

The app discovers the checkout it lives in at runtime (dev builds run
from `desktop/src-tauri/target/…`, so the repo above them is found
automatically — no path is baked into the binary). An installed copy
outside a checkout starts unconfigured and prompts for the folder; use
"Set Lumiverse Folder…" in the menu to change it at any time.

Server output is written to `runner.log` in the platform app-log directory
(macOS: `~/Library/Logs/chat.lumiverse.tray/`; Linux: the XDG state/log
directory selected by Tauri).

## Build

```bash
cd desktop
bun install
bun run tauri build
```

Bundles land in `desktop/src-tauri/target/release/bundle/` (`.app`/`.dmg`
on macOS, `.msi`/`.exe` installers on Windows, and Linux packages such as
`.deb`, `.rpm`, or `.AppImage` when built on Linux). Builds are unsigned;
signing/notarization is left to release infrastructure.
