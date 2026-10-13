---
title: Experimental Lumiverse Desktop
---

# Experimental Lumiverse Desktop

Lumiverse Desktop is an experimental Tauri-powered integrated browser with a
macOS menu bar, Windows system tray, and Linux StatusNotifier (AppIndicator)
icon. It runs a local Lumiverse checkout without leaving a terminal open and
opens Lumiverse in its native desktop window. The tray keeps server controls,
status, and update actions within reach.

It is intended for people running Lumiverse from a local clone. It does not
support Termux, Docker, or a remote Lumiverse server.

!!! warning "Experimental desktop app"
    Lumiverse Desktop is experimental. Use the normal browser experience if
    you need the most established path while the integrated Tauri browser
    continues to evolve.

!!! note "Optional companion"
    The standard `./start.sh` and `./start.ps1` launchers remain the normal
    way to run Lumiverse. They do not install or open the tray app
    automatically.

---

## Before you begin

Start Lumiverse normally once before setting up the tray. This lets the normal
launcher install Bun, install backend dependencies, and run the first-time
setup wizard.

The tray app uses the same Bun version as Lumiverse: Bun 1.4.2 or later.
Pre-built installers contain the desktop companion, **not** the Lumiverse
server or Bun. You still need your local Lumiverse checkout.

## Download Lumiverse Desktop

Pre-built installers are available from the
[Build Desktop workflow](https://github.com/prolix-oc/Lumiverse/actions/workflows/desktop-build.yml).
You do not need Rust or the platform build tools to install a pre-built app.

1. Sign in to GitHub and open a successful workflow run for the branch you use
   (for example, `staging`).
2. Scroll to **Artifacts** and download the `desktop-...` artifact matching
   your operating system, processor, and preferred installer format.
3. Extract the downloaded ZIP, then install the file inside:

| Platform | Processor | Installer |
|----------|-----------|-----------|
| macOS | Apple Silicon (`aarch64`) or Intel (`x64`) | `.dmg` — open it and copy the app to Applications |
| Windows | Intel/AMD (`x64`) | NSIS `.exe` or `.msi` — run the installer |
| Windows | ARM64 | NSIS `.exe` — run the installer |
| Linux | Intel/AMD (`amd64`) or ARM64 (`arm64` / `aarch64`) | `.deb` — install with your package manager; or `.AppImage` — mark executable and launch |

Workflow artifacts expire according to GitHub's retention policy. If a
download has expired, choose a newer successful run. These are branch builds,
not necessarily a published release. Published desktop installers are attached
to **Lumiverse Desktop** releases tagged `desktop-v...` on the
[Releases page](https://github.com/prolix-oc/Lumiverse/releases) when available.

!!! warning "Unsigned installers"
    Windows installers are unsigned, and macOS builds use ad-hoc signing
    without Apple notarization. SmartScreen or Gatekeeper may warn or block
    installation or launch. Only install downloads from the official repository
    that you trust; do not disable system-wide security protections.

Windows needs WebView2 (included with most Windows 11 installations). Linux
still needs the matching WebKitGTK 4.1 and AppIndicator runtime libraries;
an AppImage does not remove every system dependency. GNOME Shell also needs
an AppIndicator/KStatusNotifier extension for the tray icon to appear.

After installation, skip to [Connect Lumiverse Desktop to Lumiverse](#connect-lumiverse-desktop-to-lumiverse).

## Build from source (optional)

Build locally if you prefer, or if no suitable pre-built installer is available.
Only this path requires the following build tools:

| Platform | Required tools |
|----------|----------------|
| macOS | [Rust](https://rustup.rs/) stable and Xcode Command Line Tools (`xcode-select --install`) |
| Windows | [Rust](https://rustup.rs/) stable, the Microsoft C++ Build Tools, and WebView2 (included with most Windows 11 installations) |
| Linux | [Rust](https://rustup.rs/) stable plus the GTK/WebKitGTK and AppIndicator packages listed below |

### Linux build dependencies

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

### Build Lumiverse Desktop

From the root of your Lumiverse checkout, run:

```bash
cd desktop
bun install
bun run tauri:finalized build
```

The finished app and installer files are placed under
`desktop/src-tauri/target/release/bundle/`.

=== "macOS"

    Open the generated `.app` or install from the generated `.dmg`.

=== "Windows"

    Run the generated `.msi` or `.exe` installer, then open **Lumiverse Desktop**
    from the Start menu.

=== "Linux"

    Install the generated package for your distribution (`.deb` or `.rpm`) or
    run the generated `.AppImage`, then open **Lumiverse Desktop** from your
    desktop's application launcher.

!!! tip "Building from a checkout"
    When you run a build directly from your Lumiverse checkout, the tray can
    usually find that checkout automatically. If you install the app elsewhere
    or move the checkout later, configure it manually as described below.

---

## Connect Lumiverse Desktop to Lumiverse

1. Open **Lumiverse Desktop**. Its icon appears in the macOS menu bar, Windows
   notification area, or Linux desktop's status area. On GNOME, first enable
   an AppIndicator/KStatusNotifier extension as described above.
2. Open the tray menu and choose **Set Lumiverse Folder…**.
3. Select the root folder of your Lumiverse clone—the folder containing
   `start.sh`, `start.ps1`, and `scripts/`.
4. The tray finds Bun automatically. If it cannot, install or update Bun with
   the normal Lumiverse launcher, then reopen the tray app.
5. Choose **Start Server**. Lumiverse opens in the experimental integrated
   browser when the local server is ready.

The **Start Local Server at Launch** option is enabled by default. Disable it if you
want the tray icon to open without starting Lumiverse. You can also enable
**Launch at Login** from the tray menu.

### Connect to a remote instance

1. Choose **Instance Connection…** from the tray menu.
2. Enter the remote Lumiverse URL and save it. Remote connections require HTTPS;
   plain HTTP is accepted only for local loopback development.
3. Choose **Browser → Sign In to Remote Instance…** and finish signing in
   in your system browser.

Add the server's public HTTPS origin (for example, `https://app.example.com`)
under **Settings → Operator → Trusted Hostnames**, then restart Lumiverse.
Desktop verifies the request-specific OAuth issuer against the instance you
selected. `AUTH_BASE_URL` is an optional single-origin override, not a
requirement.

When Lumiverse terminates TLS directly with `LUMIVERSE_TLS_CERT_FILE` or
`LUMIVERSE_TLS_CONFIG_FILE`, forwarded headers are not needed. When TLS
terminates at a reverse proxy, preserve `Host`. If the proxy replaces
it, send `X-Forwarded-Host` and `X-Forwarded-Proto` and list the proxy IP or
CIDR in `TRUSTED_PROXIES`. Lumiverse does not trust those headers from arbitrary
peers.

Desktop uses authorization-code PKCE. Its refresh credential is kept in the
operating system credential store, while access tokens remain only in native
memory and are not passed into the remote WebView. Every account can see the
instance identity and its own role; serving status is shown only to administrators
and owners. Local process and checkout controls are disabled until you switch the
instance connection back to **Use Local Server**.

---

## Using Lumiverse Desktop

The menu provides:

- **Start Server / Stop Server** — controls the Lumiverse process owned by the tray app.
- **Browser** — opens or closes the integrated browser. Its submenu can reload
  that browser or open the same address in your default browser. Closing the
  integrated browser also closes its active floating widgets.
- **Serving Stats** — shows the port, process ID, uptime, branch, and version.
- **Check for Updates / Apply Update** — uses Lumiverse's normal Git-based update flow.

Closing the tray app stops the runner and the server it started. If Lumiverse
was started separately from a terminal, the tray can show that it is running,
but it does not take ownership of or stop that process.

### Native notifications

Enable notifications from **Settings > Notifications** inside the integrated
browser to register Lumiverse Desktop as a native notification destination.
The tray keeps a notification-only connection while the server is available,
including when the integrated browser is closed or its login session has
expired. Its device identity and revocable credential live in the standard
per-app configuration directory, so rebuilding the desktop app does not
silently unregister it. The credential is pinned to that server's origin and
identity. Removing the destination in Settings revokes it.

---

## Uninstalling

Lumiverse is self-contained: the folder you cloned **is** the install. The
server never writes configuration, databases, or services anywhere else on
your system, so removing it is mostly a matter of deleting that one folder.

This page covers the server, the optional Experimental Lumiverse Desktop, and the
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

### Uninstall Lumiverse Desktop

Skip this section if you never built or installed
[Lumiverse Desktop](desktop-tray.md).

#### 1. Turn off Launch at Login, then quit

If you enabled **Launch at Login**, turn it off from the tray menu before
quitting — the app removes its own login item. Then choose **Quit** (this
also stops any server the tray started).

#### 2. Remove the app

=== "macOS"

    Delete **Lumiverse Desktop.app** from `/Applications` (or wherever you put
    it). Builds you never installed live inside the Lumiverse folder under
    `desktop/src-tauri/target/` and are removed along with it.

=== "Windows"

    Uninstall **Lumiverse Desktop** from **Settings → Apps**. If you ran the
    portable `.exe` instead of an installer, just delete it.

#### 3. Remove the tray app's data

The tray stores its settings, logs, notification device identity, and revocable
notification credential in the standard per-app locations:

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
    reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "Lumiverse Desktop" /f
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

Then quit and reopen Lumiverse Desktop.

### The build fails

Confirm that Rust stable and the platform build tools listed above are
installed, then run the build commands again from `desktop/`. The tray is a
native app, so it needs those tools even though the Lumiverse server itself
does not.
