---
title: Desktop Tray Companion
---

# Desktop Tray Companion

Lumiverse Tray is an optional macOS menu bar and Windows system tray app for
running a local Lumiverse checkout without leaving a terminal open. It can
start and stop the server, open the web dashboard, show basic serving details,
and check for updates.

It is intended for people running Lumiverse from a local clone. It does not
support Linux, Termux, Docker, or a remote Lumiverse server.

!!! note "Optional companion"
    The standard `./start.sh` and `./start.ps1` launchers remain the normal
    way to run Lumiverse. They do not install or open the tray app
    automatically.

---

## Before you begin

Start Lumiverse normally once before setting up the tray. This lets the normal
launcher install Bun, install backend dependencies, and run the first-time
setup wizard.

You also need the following build tools:

| Platform | Required tools |
|----------|----------------|
| macOS | [Rust](https://rustup.rs/) stable and Xcode Command Line Tools (`xcode-select --install`) |
| Windows | [Rust](https://rustup.rs/) stable, the Microsoft C++ Build Tools, and WebView2 (included with most Windows 11 installations) |

The tray app uses the same Bun version as Lumiverse: Bun 1.3.13 or later.

---

## Build the tray app

From the root of your Lumiverse checkout, run:

```bash
cd desktop
bun install
bun run tauri build
```

The finished app and installer files are placed under
`desktop/src-tauri/target/release/bundle/`.

=== "macOS"

    Open the generated `.app` or install from the generated `.dmg`.

=== "Windows"

    Run the generated `.msi` or `.exe` installer, then open **Lumiverse Tray**
    from the Start menu.

!!! tip "Building from a checkout"
    When you run a build directly from your Lumiverse checkout, the tray can
    usually find that checkout automatically. If you install the app elsewhere
    or move the checkout later, configure it manually as described below.

---

## Connect the tray to Lumiverse

1. Open **Lumiverse Tray**. Its icon appears in the macOS menu bar or Windows
   notification area.
2. Open the tray menu and choose **Set Lumiverse Folder…**.
3. Select the root folder of your Lumiverse clone—the folder containing
   `start.sh`, `start.ps1`, and `scripts/`.
4. The tray finds Bun automatically. If it cannot, install or update Bun with
   the normal Lumiverse launcher, then reopen the tray app.
5. Choose **Start Server**. The dashboard action becomes available once the
   server is running.

The **Start Server at Launch** option is enabled by default. Disable it if you
want the tray icon to open without starting Lumiverse. You can also enable
**Launch at Login** from the tray menu.

---

## Using the tray app

The menu provides:

- **Start Server / Stop Server** — controls the Lumiverse process owned by the tray app.
- **Open Web Dashboard** — opens your configured local Lumiverse address.
- **Serving Stats** — shows the port, process ID, uptime, branch, and version.
- **Check for Updates / Apply Update** — uses Lumiverse's normal Git-based update flow.

Closing the tray app stops the runner and the server it started. If Lumiverse
was started separately from a terminal, the tray can show that it is running,
but it does not take ownership of or stop that process.

---

## Troubleshooting

### The tray says no Lumiverse folder is configured

Choose **Set Lumiverse Folder…** and select the root of the clone, not the
`desktop` subfolder. The selected folder must contain `scripts/runner.ts`.

### The tray cannot find Bun

Run the normal launcher from the Lumiverse root once:

=== "macOS"

    ```bash
    ./start.sh
    ```

=== "Windows"

    ```powershell
    .\start.ps1
    ```

Then quit and reopen Lumiverse Tray.

### The build fails

Confirm that Rust stable and the platform build tools listed above are
installed, then run the build commands again from `desktop/`. The tray is a
native app, so it needs those tools even though the Lumiverse server itself
does not.
