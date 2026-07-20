# Lumiverse Tray

A macOS menu bar / Windows system tray companion for the Lumiverse server.
It sits in the tray and lets you start and stop the server, open the web
dashboard, watch serving stats (port, PID, uptime, branch, version), and
check for / apply updates — without keeping a terminal open.

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
- **Open Web Dashboard** — opens `http://localhost:<port>` (port comes
  from your `.env`, default 7860).
- **Serving Stats** — port, PID, uptime, branch, version.
- **Check for Updates / Apply Update** — the runner's existing git-based
  update flow.
- **Start Server at Launch** — start the server automatically when the
  tray app opens (on by default).
- **Launch at Login** — register the tray app as a login item.
- **Set Lumiverse Folder…** — point the app at a different checkout.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3.13 (also required by the server itself)
- [Rust](https://rustup.rs) stable (Tauri v2 builds the native shell)
- macOS: Xcode Command Line Tools. Windows: WebView2 runtime
  (preinstalled on Windows 11) and the MSVC build tools.

## Develop

```bash
cd desktop
bun install
bun run tauri dev
```

By default the app manages the checkout it lives in (`desktop/..`). Use
"Set Lumiverse Folder…" in the menu, or set `LUMIVERSE_REPO_DIR` at build
time, to point it elsewhere.

Server output is written to `runner.log` in the platform app-log
directory (macOS: `~/Library/Logs/chat.lumiverse.tray/`).

## Build

```bash
cd desktop
bun install
bun run tauri build
```

Bundles land in `desktop/src-tauri/target/release/bundle/` (`.app`/`.dmg`
on macOS, `.msi`/`.exe` installers on Windows). Builds are unsigned;
signing/notarization is left to release infrastructure.
