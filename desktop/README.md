# Lumiverse Desktop (Experimental)

An experimental Tauri-powered Lumiverse desktop app for macOS, Windows, and
Linux. It opens Lumiverse in an integrated native WebView and keeps a tray
icon available for server controls, status, and updates.

On Windows, installing a rebuilt desktop app restores the session after its
automatic restart. A local server that was running (or starting) starts again,
even if **Auto-start Server** is disabled. A stopped server stays stopped for
that restart. The integrated browser reopens only if it was visible at the
installer handoff; a hidden browser stays hidden. These one-time choices also
apply to a fallback relaunch if installation fails, and do not change saved
auto-start preferences. Remote browsers reopen on the selected remote instance;
externally managed local servers are not restarted by Desktop.

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
- **Browser** — opens or closes the integrated Tauri browser. Its submenu also
  reloads it or opens the current address in your default browser. Closing the
  integrated browser also closes its active floating widgets.
  For a remote instance, this submenu also provides sign-in and sign-out.
- **Floating Widgets** — lists live extension widgets registered by Lumiverse
  (for example, SpotifyControls). Selecting one starts that extension in a
  widget-only native window.
- **Serving Stats** — port, PID, uptime, branch, version.
- **Check for Updates / Apply Update** — the runner's existing git-based
  update flow.
- **Start Local Server at Launch** — start the local server automatically when the
  tray app opens (on by default).
- **Launch at Login** — register the tray app as a login item.
- **Set Lumiverse Folder…** — point the app at a different checkout.
- **Instance Connection…** — use the local server or connect to a remote
  Lumiverse origin.

## Remote instances

Choose **Instance Connection…**, enter the remote Lumiverse origin, and sign in
in the system browser. Remote origins require HTTPS; plain HTTP is accepted only
for loopback development. Add the public HTTPS origin under **Settings →
Operator → Trusted Hostnames**, then restart the server so it can advertise that
origin as its OAuth issuer. `AUTH_BASE_URL` remains available as an optional
single-origin override, but it is not required. Desktop uses authorization-code PKCE and stores only
the refresh credential in the operating system credential store. Access tokens
remain in native memory and are never exposed to the remote WebView.

When Lumiverse terminates TLS directly with `LUMIVERSE_TLS_CERT_FILE` or
`LUMIVERSE_TLS_CONFIG_FILE`, forwarded headers are not needed. When TLS
terminates at a reverse proxy, preserve `Host`. If the proxy replaces
it, send `X-Forwarded-Host` and `X-Forwarded-Proto` and list the proxy IP or
CIDR in `TRUSTED_PROXIES`. Lumiverse ignores those identity-sensitive headers
from unlisted peers.

All signed-in accounts can see the instance identity and their own role. Serving
status remains restricted to Lumiverse administrators and owners. Local server,
checkout, and update controls are disabled while a remote instance is selected.

## Extension screen capture

The capture device named **Lumiverse Desktop** represents this client, not a
restriction to its own window. On macOS, requests open the system picker directly,
initially in **Entire Display** mode, with both displays and windows allowed.
The capture menu-bar icon also offers **Choose a Window…** and **Choose a Display…**.
For Window, bring the other application's window into view and select it using the
macOS overlay. Any explicitly opened capture controls and
Lumiverse windows are excluded from window selection. Full-display capture can
include visible Lumiverse windows and other sensitive content: use **Review Before
Sending** when local inspection is needed. There is no always-on screen buffer.

The macOS development executable embeds `src-tauri/Info.plist` to retain the
packaged application's bundle identifier. Restart `bun run tauri dev` after
changes to this metadata.

On macOS 14+ or Windows 10 1903+/Windows 11, choose
**Browser → Enable Extension Screen Capture…**. This signs
the native client into the selected local or remote instance if necessary; it
does not reuse browser cookies. An extension still needs explicitly granted
`screen_capture`/`screen_recording` and `generation` permissions.

Every request opens the OS source picker directly. On macOS there is no Lumiverse
recording popup: a temporary camera/recording menu-bar item provides the request
identity, destination, countdown and **Stop & Discard**, alongside macOS's sharing
controls. **Capture Details & Permissions…** opens recovery controls only on an
explicit owner action; optional review likewise opens a preview only when requested.
Windows uses its system picker for either an application window or display, with
a compact native identity/destination and stop HUD. Full Windows consent details
live under **Details…**. Recording does not foreground the main app window. Selecting
a source authorizes this one image or bounded clip and its release to the displayed
instance/model. After capture and validation, the extension receives an opaque
asset for processing automatically; no second Send click is needed. Every request
still requires native source selection; no approval or target is remembered.
**Review Before Sending** optionally pauses release for a compact local preview
and **Share This Capture**, for this request only. **Stop & Discard** or closing
an explicitly opened capture window before release uploads nothing. Capture stays disabled
at launch, and must be re-enabled after transport failure. Instance changes and
desktop OAuth sign-out stop it.

Images stay in native memory. Both adapters record video-only H.264 MP4, at most
1080p/30fps and 30 seconds; oversized output is discarded before sharing.

- **macOS:** ScreenCaptureKit plus hardware-required VideoToolbox/AVAssetWriter
  encoding. An owner-only temporary MP4 is removed after preview/share/discard.
  If a hardware encoder is unavailable, only screenshots are advertised; software
  fallback is forbidden. Building requires a macOS 15+ SDK; runtime requires macOS 14+.
- **Windows:** Windows Graphics Capture's system picker and hardware D3D11
  surfaces, with a two-frame pool. MediaTranscoder requests hardware acceleration
  and stores the MP4 in memory, including native playback preview. Windows may
  choose a software encoder; the consent panel discloses this rather than claiming
  a verified hardware-only encoder. Source closure/resizing, screen lock/logoff,
  session disconnect, sleep, and transport cancellation discard the request.
- **Linux and rolling replay buffers:** not implemented or advertised. Windows
  **Replay Clip** only replays the already-recorded local preview; it does not
  arm an always-on capture buffer.

Tokens, media, and capture paths never cross WebView IPC. See
`developer-docs/docs/getting-started/desktop-capture.md` for the protocol,
security boundaries, and on-device acceptance checks.

### macOS permission recovery

The system sharing picker remains the default; it authorizes the selected source
without requiring app-wide Screen Recording access. If it only offers Lumiverse's
window, use the capture menu-bar icon → **Capture Details & Permissions… → Grant
Screen Recording Access…**. This
is a local owner action, never an extension or frontend permission request.
If needed, **Open Screen Recording Settings…** opens **System Settings → Privacy &
Security → Screen & System Audio Recording**. Enable the requesting app, restart
the desktop client if macOS asks, and start a new request; capture never resumes
automatically. Despite the privacy pane's name, system audio and microphone capture
remain disabled.

With app-wide access granted, **Choose From Permissioned Source List…** offers
entire displays and other applications' visible windows in a native dropdown.
Nothing is selected automatically: choose a target and press **Capture Selected
Source** to authorize that one capture and send. **Review Before Sending** is
optional, not a mandatory release step. The permission is
checked before capture, during the request, and before sharing; revocation discards
the capture. Source names and IDs never reach the extension. **Use macOS Picker
Instead** returns to scoped OS selection without using app-wide access.

Tauri development runs a plain executable, not a `.app` bundle. Embedding the
bundle identifier does not guarantee that macOS will list this executable as
Lumiverse Desktop in its privacy pane; a development launcher can be attributed
instead. Prefer testing a bundled debug app rather than granting broader access
to Terminal or your editor:

```bash
cd desktop
bun run tauri build --debug --bundles app -- --offline --locked
```

Quit the development client before opening
`src-tauri/target/debug/bundle/macos/Lumiverse Desktop.app`, and explicitly re-enable
extension capture there. Native diagnostic lines prefixed `[Lumiverse capture]`
report app identity, permission state, selected source style, and error domain/code,
not window names, screen contents, credentials, or model prompts.

The extension's **Desktop device** dropdown lists native client registrations,
not screens or windows. Target selection happens only in the native OS picker
after **Share**. Rebuilding/restarting can briefly leave an old registration until
its 45-second lease expires; refresh the extension's configuration after that.
Two active clients can also have the same display name, so registrations must not
be merged just because both are called Lumiverse Desktop.

### Windows live testing

From an x64 Visual Studio Developer PowerShell with the Windows SDK, Rust/MSVC,
Bun, and WebView2 installed, run from the repository root:

```powershell
bun install --frozen-lockfile
cd desktop
bun install --frozen-lockfile
bun run build
cargo test --locked --lib --manifest-path src-tauri/Cargo.toml capture::
bun run tauri dev
```

Enable capture in the tray, grant the test extension `screen_capture`,
`screen_recording`, and `generation`, then request an image and 1–30-second clips
against a model that supports the selected media type. Confirm picker selection,
native preview/playback, explicit Share versus Discard, and cancellation on lock,
permission revocation, and instance/transport changes. A Windows N edition may
need the Media Feature Pack for recording/playback. Check GPU video-encode
activity on the actual device; enabling hardware acceleration does not prove
that Windows selected a hardware encoder. No recording file is written by this
adapter; memory may still be paged by the OS. Full on-device acceptance remains
required before release.

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

`blur` uses macOS vibrancy and the supported Desktop Acrylic system backdrop on
current Windows 11 builds. Older Windows releases retain the legacy DWM blur
fallback. On other platforms, or when native material is unavailable, the theme
keeps its regular translucent CSS surface. Browser and PWA rendering ignore this
desktop-only setting.

## Run a prebuilt Linux AppImage

The release AppImage already contains the compiled Rust shell, its GTK 3 /
WebKitGTK 4.1 libraries, and the GStreamer plugins used for browser audio.
Running it does **not** require Cargo, a Rust toolchain, a system WebKitGTK
package, or system GStreamer plugins. Lumiverse Desktop still requires
[Bun](https://bun.sh) ≥ 1.4.2 and a Lumiverse checkout because the desktop
companion does not bundle the server.

Download the artifact matching the machine (`amd64`/`x86_64` for most PCs or
`aarch64` for ARM64), then run it from a terminal once so startup errors remain
visible:

```bash
chmod +x Lumiverse*.AppImage
./Lumiverse*.AppImage
```

The app starts as a tray application. KDE Plasma exposes its StatusNotifier
item in the system tray; it does not open a normal taskbar window until the
server is ready. Use `pgrep -af lumiverse-tray` to distinguish a hidden running
process from an early startup failure.

If the AppImage reports a FUSE error, either install Arch's `fuse2` package or
use the AppImage runtime's extract-and-run fallback:

```bash
sudo pacman -S --needed fuse2
APPIMAGE_EXTRACT_AND_RUN=1 ./Lumiverse*.AppImage
```

On Wayland, Lumiverse automatically selects the native GTK backend when no X11
display is available. If KDE advertises an XWayland display but that path still
fails, force native Wayland without relying on the `GDK_BACKEND` value that
older Tauri AppImage launchers overwrite:

```bash
LUMIVERSE_GDK_BACKEND=wayland ./Lumiverse*.AppImage
```

WebKitGTK 6.0 is the GTK 4 API and does not replace WebKitGTK 4.1/GTK 3. Neither
needs to be installed separately for the AppImage; source builds require the
4.1 package shown below.

## Source-build prerequisites

Run `bun run desktop:doctor` from the repository root to check all build
requirements at once. It reports what is missing and the exact command to
install it.

- [Bun](https://bun.sh) ≥ 1.4.2 (also required by the server itself)
- [Rust](https://rustup.rs) stable (Tauri v2 builds the native shell)

Platform-specific build requirements:

- **macOS:** Xcode Command Line Tools.
- **Windows:** WebView2 Runtime (preinstalled on Windows 11) and Visual Studio
  Build Tools with **Desktop development with C++**, including the MSVC C++
  compiler and Windows SDK. The scripted build locates the installed toolset
  and initializes its linker environment; a normal PowerShell window is fine.
  If the MSVC check fails, verify the C++ workload in Visual Studio Installer
  or run `where link.exe` from the x64 Native Tools Command Prompt. In
  PowerShell, use `where.exe link.exe` (`where` is a PowerShell alias).
- **Linux:** GTK/WebKitGTK development libraries plus an AppIndicator
  implementation. The helper publishes its tray icon through the
  StatusNotifierItem/AppIndicator D-Bus protocol.

  Debian/Ubuntu:

  ```bash
  sudo apt install build-essential curl wget file libssl-dev \
    libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
    librsvg2-dev libxdo-dev gstreamer1.0-tools \
    gstreamer1.0-plugins-base gstreamer1.0-plugins-good
  ```

  Fedora:

  ```bash
  sudo dnf install gcc gcc-c++ make curl wget file openssl-devel \
    webkit2gtk4.1-devel libappindicator-gtk3-devel \
    librsvg2-devel libxdo-devel gstreamer1 \
    gstreamer1-plugins-base gstreamer1-plugins-good
  ```

  Arch Linux:

  ```bash
  sudo pacman -S --needed base-devel curl wget file openssl \
    webkit2gtk-4.1 libappindicator-gtk3 librsvg libxdo \
    gstreamer gst-plugins-base gst-plugins-good
  ```

  Package names vary by distribution. `libayatana-appindicator3-dev` may be
  substituted with the distribution's `libappindicator` development package.
  The GStreamer plugin sets are copied into AppImage builds so WebKit's audio
  support does not depend on host plugins hidden by the AppImage launcher.
  The other packages are build dependencies; a machine running an unpackaged
  Linux binary also needs the matching AppIndicator runtime library.

  GNOME Shell does not show StatusNotifier items by default, so install and
  enable an AppIndicator/KStatusNotifier extension (for example,
  **AppIndicator and KStatusNotifierItem Support**).

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

Each backend start or restart gets a timestamped `server-*.log` in the platform
app-log directory (macOS: `~/Library/Logs/chat.lumiverse.tray/`; Windows:
`%LOCALAPPDATA%\\chat.lumiverse.tray\\logs\\`; Linux:
`${XDG_DATA_HOME:-~/.local/share}/chat.lumiverse.tray/logs/`). Launcher output
before the first server start is kept in a timestamped `launcher-*.log`. Each
file is capped at 10 MiB and only the 12 newest launcher/server logs are
retained. In a development build, `bun run tauri dev` also mirrors output to
its terminal, including server startup failures.

## Build

For a normal scripted install from the repository root, use:

```bash
./start.sh --install-desktop
```

On Windows, run `.\start.ps1 -InstallDesktop` instead. The launcher checks the
native toolchain, builds the Tauri bundle, installs it in the platform's normal
application location, and creates the platform launcher plus a desktop
shortcut when that folder is available. `--desktop` and `-Desktop` are shorter
aliases.

An existing Lumiverse Desktop process is stopped immediately before the new
bundle is installed. The shutdown includes its runner/server process tree and
the install aborts instead of overwriting files if that process cannot be
stopped.

On macOS, the app is installed in `/Applications` so Spotlight and the system
Applications interface discover it normally. macOS may request administrator
approval while staging the app there. The installer also removes the obsolete
`~/Applications/Lumiverse Desktop.app` location used by early builds so
LaunchServices cannot reopen a stale duplicate after an update.

On Windows, this command also downloads the official architecture-matched
`rustup-init.exe` and installs the minimal stable Rust toolchain automatically
when `cargo` is missing. `bun run desktop:doctor` remains available when you
only want to inspect prerequisites or follow the manual installation path.

To build bundles without installing them:

```bash
cd desktop
bun install
bun run tauri:finalized build
```

On Windows, run these manual commands from the appropriate Visual Studio
Developer Command Prompt (x64 Native Tools for an x64 build), so `link.exe`
and the SDK are available. `\.\start.ps1 -InstallDesktop` configures the
installed toolchain automatically when run from an ordinary PowerShell window.

On Linux, Tauri bundles the GStreamer media framework needed by WebKit audio.
The finalizer verifies the audio plugins and their AppRun search paths, removes
the build runner's `libwayland-client` so Mesa and EGL use the host display
stack, then extracts and checks the finished image before the build succeeds.
Other bundle formats and platforms pass through unchanged.

Bundles land in `desktop/src-tauri/target/release/bundle/` (`.app`/`.dmg`
on macOS, `.msi`/`.exe` installers on Windows, and Linux packages such as
`.deb`, `.rpm`, or `.AppImage` when built on Linux).

## Automated releases

Installers are built for Windows x64 (`.exe`/`.msi`), Windows ARM64
(`.exe`, NSIS-only — WiX/MSI has no ARM64 support, cross-compiled on the x64
Windows runner), Linux x64 and ARM64 (`.AppImage`/`.deb`, built natively on
Ubuntu 22.04), and separate macOS Apple Silicon and Intel (`.dmg`).

- **`desktop-build.yml` — version-bump builds.** Pushes to any branch other
  than `main` trigger a build when a desktop version manifest or `Cargo.lock`
  changes. Results are downloadable workflow artifacts; no release is created.
  Manual dispatch works the same way.
- **`desktop-release.yml` — staging → main merges.** Merging a `staging` PR
  that touches `desktop/**` into `main` builds fresh installers from the merge
  commit and attaches them to a `desktop-v<version>` release on GitHub,
  creating it if missing and pinning it to the merge commit. Reruns replace
  matching assets; if any platform build fails, nothing is attached.
- Desktop versioning is independent of server release tags. One command keeps
  the four version-bearing files in sync:

  ```bash
  bun run desktop:version 0.3.0
  ```

  This rewrites `desktop/package.json`, `src-tauri/Cargo.toml`, and
  `src-tauri/tauri.conf.json`, then refreshes `src-tauri/Cargo.lock` through
  `bun run desktop:lock` — cargo is the lockfile's only writer, never edit it
  by hand. Commit the four changed files together; CI checks the locked
  dependency resolution and version agreement before starting any platform
  builds.

## License

Lumiverse Desktop is covered by the project's
[Lumiverse Community License 2.1](../LICENSE.md). Cargo and the installer
configuration reference that canonical file; desktop bundles include it as
`LICENSE.md`. Third-party dependencies retain their own licenses.
