---
title: Desktop Tray Companion
---

# Desktop Tray Companion

Lumiverse Tray is an optional macOS menu bar, Windows system tray, and Linux
StatusNotifier (AppIndicator) app for running a local Lumiverse checkout
without leaving a terminal open. It can start and stop the server, open the
web dashboard, show basic serving details, and check for updates.

It is intended for people running Lumiverse from a local clone. It does not
support Termux, Docker, or a remote Lumiverse server.

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
| Linux | [Rust](https://rustup.rs/) stable plus the GTK/WebKitGTK and AppIndicator packages listed below |

The tray app uses the same Bun version as Lumiverse: Bun 1.3.13 or later.

### Linux dependencies

The Linux tray icon uses the StatusNotifierItem/AppIndicator D-Bus protocol.
Install the required native packages before building the app:

=== "Debian / Ubuntu"

    ```bash
    sudo apt install build-essential curl wget file libssl-dev \
      libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
      librsvg2-dev libxdo-dev
    ```

=== "Fedora"

    ```bash
    sudo dnf install gcc gcc-c++ make curl wget file openssl-devel \
      webkit2gtk4.1-devel libappindicator-gtk3-devel \
      librsvg2-devel libxdo-devel
    ```

=== "Arch Linux"

    ```bash
    sudo pacman -S --needed base-devel curl wget file openssl \
      webkit2gtk-4.1 libappindicator-gtk3 librsvg libxdo
    ```

Package names vary by distribution. If your distribution does not provide
`libayatana-appindicator3-dev`, use its `libappindicator` development package
instead. An unpackaged Linux build also needs the matching AppIndicator
runtime library on the computer where it runs.

KDE Plasma displays these tray items natively. GNOME Shell needs an
AppIndicator/KStatusNotifier extension, such as **AppIndicator and
KStatusNotifierItem Support**, before the icon will appear.

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

=== "Linux"

    Install the generated package for your distribution (`.deb` or `.rpm`) or
    run the generated `.AppImage`, then open **Lumiverse Tray** from your
    desktop's application launcher.

!!! tip "Building from a checkout"
    When you run a build directly from your Lumiverse checkout, the tray can
    usually find that checkout automatically. If you install the app elsewhere
    or move the checkout later, configure it manually as described below.

---

## Connect the tray to Lumiverse

1. Open **Lumiverse Tray**. Its icon appears in the macOS menu bar, Windows
   notification area, or Linux desktop's status area. On GNOME, first enable
   an AppIndicator/KStatusNotifier extension as described above.
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

## Uninstalling

Lumiverse is self-contained: the folder you cloned **is** the install. The
server never writes configuration, databases, or services anywhere else on
your system, so removing it is mostly a matter of deleting that one folder.

This page covers the server, the optional Desktop Tray Companion, and the
shared tools that Lumiverse installs but does not own.

!!! warning "Your data lives in the folder"
    The `data/` directory inside your Lumiverse folder holds your characters,
    chats, world books, and accounts. Deleting the folder deletes all of it.
    If you want to keep anything, [export it first](../data-portability/exporting.md).

---

### Uninstall the Lumiverse server

1. Stop the server (**Ctrl + C** in its terminal, or **Stop Server** in the
   tray app).
2. Delete the folder you cloned:

=== "macOS"

    ```bash
    rm -rf /path/to/Lumiverse
    ```

=== "Windows"

    ```powershell
    Remove-Item -Recurse -Force C:\path\to\Lumiverse
    ```

That is the entire server uninstall. There are no launch daemons, registry
entries, or hidden data directories to clean up — everything lived in the
folder.

!!! tip "Resetting instead of uninstalling"
    To start fresh without removing Lumiverse, delete just `data/` and `.env`
    inside the folder, then run the setup wizard again.

---

### Uninstall the Desktop Tray Companion

Skip this section if you never built or installed
[Lumiverse Tray](desktop-tray.md).

#### 1. Turn off Launch at Login, then quit

If you enabled **Launch at Login**, turn it off from the tray menu before
quitting — the app removes its own login item. Then choose **Quit** (this
also stops any server the tray started).

#### 2. Remove the app

=== "macOS"

    Delete **Lumiverse Tray.app** from `/Applications` (or wherever you put
    it). Builds you never installed live inside the Lumiverse folder under
    `desktop/src-tauri/target/` and are removed along with it.

=== "Windows"

    Uninstall **Lumiverse Tray** from **Settings → Apps**. If you ran the
    portable `.exe` instead of an installer, just delete it.

#### 3. Remove the tray app's data

The tray stores its settings and logs in the standard per-app locations:

=== "macOS"

    ```bash
    rm -rf ~/Library/{Application\ Support,Caches,WebKit}/chat.lumiverse.tray \
           ~/Library/{Caches,WebKit}/lumiverse-tray
    ```

=== "Windows"

    ```powershell
    Remove-Item -Recurse -Force $env:APPDATA\chat.lumiverse.tray,
        $env:LOCALAPPDATA\chat.lumiverse.tray -ErrorAction SilentlyContinue
    ```

#### 4. Check for a leftover login item

Only present if **Launch at Login** was enabled and step 1 was skipped:

=== "macOS"

    The login item is a LaunchAgent plist in `~/Library/LaunchAgents`:

    ```bash
    ls ~/Library/LaunchAgents | grep -i lumiverse
    ```

    If one is listed, unregister and delete it (substitute the name you found):

    ```bash
    launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/chat.lumiverse.tray.plist
    rm -f ~/Library/LaunchAgents/chat.lumiverse.tray.plist
    ```

=== "Windows"

    The login item is a per-user registry value (no admin rights involved):

    ```powershell
    reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "Lumiverse Tray" /f
    ```

Nothing tray-related is ever installed system-wide: no `/Library/LaunchDaemons`
entries on macOS, no HKLM registry keys or services on Windows.

---

### Shared tools Lumiverse does not own

These are general-purpose tools that remain installed. Keep them if any other
software uses them; otherwise they have their own uninstall paths:

| Tool | Why it's there | Where it lives | How to remove |
|------|----------------|----------------|---------------|
| **Bun** | Runs the server; auto-installed by `start.sh` / `start.ps1` if missing | `~/.bun` | Delete `~/.bun` and remove the `BUN_INSTALL` lines from your shell profile |
| **Rust toolchain** | Only needed if you built the tray app yourself | `~/.cargo`, `~/.rustup` | `rustup self uninstall` |
| **Git** | Cloning and updates | System package | Leave it — nearly everything uses Git |

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

=== "Linux"

    ```bash
    ./start.sh
    ```

Then quit and reopen Lumiverse Tray.

### The build fails

Confirm that Rust stable and the platform build tools listed above are
installed, then run the build commands again from `desktop/`. The tray is a
native app, so it needs those tools even though the Lumiverse server itself
does not.
