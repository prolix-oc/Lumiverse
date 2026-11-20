# Lumiverse Desktop (Experimental)

An experimental Tauri-powered Lumiverse desktop app for macOS, Windows, and
Linux. It opens Lumiverse in an integrated native WebView and keeps a tray
icon available for server controls, status, and updates.

All macOS builds require macOS 13 or later. Screen capture requires macOS 14 or
later, and system audio analysis requires macOS 14.2 or later.

Signed bundled updates restore the session after the app restarts. A local
server that was running (or starting) starts again,
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

On Windows, Desktop explicitly hides each WebView2 rendering surface while its
window is hidden or minimized, or the session's display is off. Rendering returns
when both the display and that window are visible; waking the display does not
restore hidden or minimized windows. Dimmed displays and unfocused visible
windows continue rendering. This applies to the browser, floating widgets, and
desktop dialogs without reloading pages or explicitly suspending scripts.

The built-in instance uses the packaged Bun server. Existing checkouts use the
headless source runner (`bun scripts/runner.ts --headless`). Both communicate
with the tray over a private stdio channel, and exiting the desktop stops the
server processes it owns.

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
  update flow, available when using an existing checkout.
- **Desktop Updates** — check the selected stable/nightly channel and install a
  signed release of the entire app, including its built-in server. Available
  when using a remote instance too. The app checks on launch and every six hours;
  download and installation require choosing **Update and restart**. Debug
  profiles and builds without the release signing public key disable installation.
- **Start Local Server at Launch** — start the local server automatically when the
  tray app opens (on by default).
- **Launch at Login** — register the tray app as a login item.
- **Let Extensions Analyse System Audio** — off by default (Windows, macOS 14.2+, and
  Linux with `parec`). Lets extensions
  you have granted the `system_audio` permission see levels and a frequency
  spectrum of what the computer is playing, never the audio itself. The item
  and the tray tooltip show when an extension is listening; unchecking it ends
  every session. See [System audio](../developer-docs/docs/frontend-api/system-audio.md#native-adapters).
- **Let Extensions Capture the Screen** — off by default (macOS 14+ and Windows).
  Stays enabled for the selected instance until unchecked. Source selection is
  remembered for each permitted extension, capture kind and destination.
  Unchecking it stops capture and forgets saved sources and approvals.
- **Open Lumiverse Data Folder** — open the active local server's data directory
  in Finder, Explorer, or the system file manager. Available only in local mode,
  including when the server is stopped; follows custom paths and debug profiles.
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

## Key bindings

Use **Settings → Key Bindings** in the integrated frontend to bind native desktop
actions, application commands, or registered Spindle commands. Bindings default
to focused mode.
Global configuration requires one native owner opt-in per instance/account;
individual bindings then choose global mode without repeated prompts. Disabling
globals converts current-account and shared native actions to focused bindings.
Native settings persist the configuration and report duplicate or OS-conflicting shortcuts. Extensions
receive command invocations with `context.trigger`, never arbitrary key events.
An extension can embed `ctx.components.mountKeybindingEditor(target, { commandId })`
inside its own registered panel or settings; that editor changes only its selected
registered command. It uses the same native global opt-in and persists the same bindings.
Application commands require the primary integrated browser to remain open and
signed in; the Show / Hide binding keeps its page alive in the background.
Global bindings use native registration on macOS, Windows and Linux X11. Wayland
sessions currently support app-focused bindings only.

## Extension screen capture

The native installation keeps a stable capture-device identity for each instance
and account across reconnects; secret transport leases still rotate. Spindle
workers can query destination-scoped native approval and source readiness with
`spindle.desktop.capture.getApprovalStatus()` without opening UI or starting capture.

The capture device named **Lumiverse Desktop** represents this client. Set it up
from the extension permissions area's **Set Up Screen Capture** button, or use
the top-level **Let Extensions Capture the Screen** tray toggle beside system audio. Desktop authorization
uses native OAuth and does not reuse browser cookies. The selected instance's
transport is remembered and reconnects with existing credentials after restart
or failure; interrupted captures are canceled and never retried automatically.
The native capture session handles reconnection directly, including after a
server restart or frontend reload. It registers a fresh lease and republishes
monitor metadata without waiting for the tray menu or restarting Desktop.
Reconnection stays bound to the original instance and account, preserves saved
capture approvals, and stops when capture is disabled or the instance changes.

Selecting a named Windows display in an extension starts capture using the tray
opt-in and current extension permissions, without another approval dialog or
Windows capture border. Coordinates use physical pixels on mixed-DPI desktops.
Disconnecting or moving the selected display stops capture without substituting
another display. The widget shows capture and generation progress.

For native picker sources, first use opens source selection directly. Selecting a source starts capture and remembers it for later
requests from this extension, account, capture kind and destination until capture
is turned off. There is no separate Remember choice. macOS display choices survive restart by UUID;
window choices require fresh selection after Desktop or the owning app restarts.
Windows picker captures retain the exact OS-selected item while Desktop and the source remain
alive; after restart it asks for a source again. Missing sources are never
replaced automatically. Remembered source identities and approval stay native.

Canceling a capture discards only that request and keeps saved permissions.
The macOS menu-bar indicator includes **Cancel This Capture**; Windows picker
captures retain their OS capture border. Turn **Let Extensions Capture the Screen** off in the
tray to stop capture and forget saved approvals. Turning it on again requires a
new source choice for picker captures; enabling it never starts a capture by itself. There is no
capture/review window, extra Send step, or always-on screen buffer.

The macOS development executable embeds `src-tauri/Info.plist` to retain the
packaged application's bundle identifier. Restart `bun run tauri dev` after
changes to this metadata.

On macOS 14+ or Windows 10 1903+/Windows 11, choose
**Let Extensions Capture the Screen** in the root tray menu. This signs
the native client into the selected local or remote instance if necessary; it
does not reuse browser cookies. An extension still needs explicitly granted
`screen_capture`/`screen_recording` and `generation` permissions.

The extension receives an opaque asset after capture and validation, with no
second Send click required. Revoking/regranting capture or generation permission,
changing the connection, reinstalling the extension, or changing accounts requires
fresh native approval. Source selection is required when no matching remembered
approval/source is available. Instance changes and desktop OAuth sign-out cancel
current capture.

Images stay in native memory. Both adapters record video-only H.264 MP4, at most
1080p/30fps with an 8 Mbps bitrate target and up to 120 seconds; oversized output
is discarded before sharing.
The requested duration is a cutoff. Extensions may finish a matching recording
early through `spindle.desktop.capture.finish()` and send the shorter clip through
the original request. Desk Companion maps a second invocation of its existing
share action to this control. Cancel still discards the recording.

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

**Allow Screen Recording…** is directly available in native setup. It reuses
existing app-wide permission, requests missing permission only on a native owner
action, and links directly to macOS privacy settings when recovery is needed.
Audio-only Core Audio permission does not grant screen access. Remembering uses
an explicitly selected native display/window list and requires screen permission.
The same setup flow chooses and remembers the source. Screen permission remains subject to OS reauthorization;
restart Desktop if macOS requests it. No interrupted capture resumes afterward.
System audio and microphone capture remain disabled for image/video requests.

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
cargo test --locked --lib --manifest-path src-tauri/Cargo.toml webview_visibility::
bun run tauri dev
```

Enable capture in the tray, grant the test extension `screen_capture`,
`screen_recording`, and `generation`, then request an image and 1–120-second clips
against a model that supports the selected media type. Confirm picker selection,
native preview/playback, explicit Share versus Discard, and cancellation on lock,
permission revocation, and instance/transport changes. A Windows N edition may
need the Media Feature Pack for recording/playback. Check GPU video-encode
activity on the actual device; enabling hardware acceleration does not prove
that Windows selected a hardware encoder. No recording file is written by this
adapter; memory may still be paged by the OS. Full on-device acceptance remains
required before release.

For WebView rendering, compare idle GPU activity before and after display sleep,
then repeat with the browser minimized and hidden. Confirm that restoring or
reopening it paints immediately, and that waking the display leaves hidden or
minimized windows in their existing state. Include floating widgets, a streaming
reply, page reloads, and closing/recreating the browser in this check.

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
package, or system GStreamer plugins. Fully bundled stable/nightly releases
include the server and Bun; they need neither a checkout nor an installed Bun
runtime. Checkout-only feature artifacts
require [Bun](https://bun.sh) ≥ 1.4.4 and a Lumiverse checkout. Both can connect
to a remote HTTPS instance.

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

Use **Browser → Linux Graphics & Diagnostics…** for saved backend/rendering
choices and redacted runtime diagnostics. Changes apply after quitting and
reopening Desktop. The NVIDIA explicit-sync-only mode and opaque diagnostic
windows allow controlled comparisons without modifying the bundle. Slow
compatibility modes remain explicit fallbacks. Opaque diagnostic windows fill
the rectangular native surface; leave that option off for transparent rounded
corners. See [Linux qualification](LINUX-VALIDATION.md)
for the remaining accelerated hardware and runtime validation gates.

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

### Remote Linux diagnostic builds

Build the current working tree on an SSH-accessible Linux machine with Docker:

```bash
bun run build:linux-appimage root@linux-builder --jobs 12 \
  --remote-output /srv/build-output --no-download
```

An existing SSH profile also works as the host argument. The SSH identity must
have Docker access, and the host key must already be trusted. The build runs as
an unprivileged user inside Ubuntu 22.04, with Bun 1.4.4, Rust 1.95.0, and Node
22.16.0. This preserves the nightly's OS/glibc baseline when the remote host is
Arch or another newer distribution. Native package versions are recorded in
the returned runtime manifest.

The command uploads current tracked and nonignored untracked source files,
including uncommitted changes. It excludes local dependencies, instance data,
environment files, signing material, and generated server binaries. Version
stamping and a diagnostic snapshot commit happen only in the remote copy. No
push, workflow dispatch, release upload, or updater signing is performed.

Finalized AppImages, SHA-256 checksums, runtime/source provenance, and the build
log return to `.cache/linux-appimage/<build-id>/`; use `--output <directory>` to
choose another destination. `--remote-output` also copies the result into
`<remote-directory>/lumiverse-diagnostics/<build-id>/` with readable permissions
and verifies its checksum there. `--no-download` leaves the result on the server.
The destination share must already be mounted and writable. Checksums are also
verified after any download. Each image
contains the frontend, server, Bun, and native runtime, using the same staging
and AppImage finalization scripts as release builds. These unsigned diagnostic
images are for direct testing, not updater-feed publication.

To build Linux ARM64 on the x64 server, select an emulated ARM64 container:

```bash
bun run build:linux-appimage root@linux-builder --arch arm64 --jobs 12 \
  --remote-output /srv/build-output --no-download
```

The default is `--arch x64`; `--arch arm64` also works with `--local`. On an
x64 host, an administrator must first register an ARM64 QEMU interpreter with
`binfmt_misc`. Docker's documented setup is
`docker run --privileged --rm tonistiigi/binfmt --install arm64`; this changes
the host's interpreter registration and may need repeating after a reboot.
The interpreter must be static so it can execute inside an ARM64 container.
Its ELF matching rule must also accept the `AI\x02` marker in bytes 8–10 of a
type-2 AppImage header; an ordinary ARM64 ELF execution check alone misses this.
This is a [known AppImage/binfmt interaction](https://github.com/AppImage/AppImageKit/issues/965).
The builder checks both cases before installing toolchains and reports a
registration error early. It never changes host interpreter registrations
itself. Emulated compilation can be substantially slower than a native ARM
machine.

On an x64 Linux host, add `--cross` to compile ARM64 using native x64 Rust
and linker tools:

```bash
bun run build:linux-appimage root@linux-builder --arch arm64 --cross --jobs 12 \
  --smoke --remote-output /srv/build-output --no-download
```

This retains Rust 1.95.0, the release optimization profile, and the Ubuntu 22.04
baseline. The native compiler uses headers and libraries copied from the exact
ARM64 runtime container. ARM64 server checks, application tests, and AppImage
packaging still execute under QEMU. The finished image must pass offline
cross-user startup and WebKit interaction when `--smoke` is selected. Compilation
and bundling are separate Tauri commands, so packaging does not compile Rust
again. Cross-builds use their own `lumiverse-appimage-cross-arm64-*` caches,
with separate x64 and ARM64 Node dependencies, and return compiler/runtime
image IDs with the artifacts. `--cross` also works with `--local --arch arm64`.
The first cross-build fills a new dependency cache. Cargo timing reports are
retained in its target volume; serial compiler phases can still use one core.

ARM64 uses a separate builder image, build lock, Cargo target tree, Bun cache,
and packaging-tool cache. The existing x64 caches remain available. The build
checks Bun and Rust's actual architecture, and verifies the finalized runtime
manifest before sharing or downloading the result. Both architectures retain
the Ubuntu 22.04 baseline and require no host desktop session. ARM64 diagnostic
tests allow 60 seconds per test for emulated subprocesses; x64 retains Bun's
five-second default. Rust unit tests under QEMU use two parallel workers, and
timing-sensitive assertions allow for emulated scheduler delays. The release
compiler settings are unchanged.

This diagnostic command runs independently of GitHub Actions. Nightly release
builds use the private runner integration described below.

The remote machine retains source snapshots/logs under
`~/.cache/lumiverse-appimage-build/runs/` and Docker volumes named
`lumiverse-appimage-*` for Cargo, Bun, and packaging caches. Builds serialize
access to these caches. The first build compiles dependencies; subsequent
iterations reuse them. Checks cover native desktop policies, server setup and
runtime, and packaging. No desktop session is required. Add `--smoke` to also run
offline Xvfb interaction in the container, independently of the host's LXDE/X11
session. The release CI's stronger cross-user namespace test and real GPU/
Wayland checks remain separate.

From a checkout on the Linux build server itself, use the same builder locally:

```bash
bun run build:linux-appimage --local --jobs 12 \
  --output /srv/build-output
```

This writes `<output-directory>/<build-id>/` and requires Docker access. The
`build:linux-remote` command remains an alias for the same builder.

### Private Windows, Intel macOS and nightly Linux release builds

The public nightly workflow sends an immutable build request to the private
`Lumiverse-Builds` repository. Its self-hosted Linux runner builds x64 and
ARM64 AppImages in separate Ubuntu 22.04 containers and compiler caches,
retaining the release tests and offline cross-user smoke checks. Sources with
the cross-builder compile ARM64 using native x64 Rust tools and reserve QEMU
for ARM64 execution and packaging. Older immutable requests retain the
emulated compiler path; `arm64_compiler=emulated` also selects it explicitly.
Only trusted `main` and `staging` workflow requests can reach this builder.

Windows x64 and ARM64 compilation uses the private `lumiverse-windows-vm`
runner for both nightly and stable releases. The same authenticated request
pins the source SHA, release version, channel and updater public key. The VM
builds the final unsigned NSIS installers, tests the x64 server, verifies PE
architectures and returns checksums and provenance. A short hosted Windows
ARM64 job runs the exact cross-built server on native ARM64 and records the
server/installer hashes and private build identity. No signing keys reach the VM.

Intel macOS releases use the private `lumiverse-macos-vm` runner. It validates
and reuses the matching published LanceDB addon, or compiles and tests it if no
matching build exists. It returns the ad-hoc-signed application, DMG and
checksummed provenance for hosted publication and updater signing. A newly
compiled native addon is included for publication; published addons are reused.

The completed private run wakes the public completion workflow. GitHub-hosted
jobs verify source, runtime provenance, native ARM64 qualification and checksums, sign the finalized payloads,
and independently verify their updater signatures. Signing keys remain in the
public repository's hosted jobs. Publication still requires all six platforms
and successful hosted builds; neither completion order advances a partial feed.

Private build handoffs and diagnostic artifacts have one-day retention. Once
the signed release and channel feed publish successfully, the completion job
removes that request's private handoffs immediately. Failed or incomplete
releases keep their handoffs for retries within that day. The private controller
also prunes completed build artifacts older than a day before compilation and
every six hours. These are Actions artifacts; Cargo/Bun compiler caches and
published installers remain available. GitHub bills artifact storage separately
from cache storage, so clearing compiler caches does not resolve an artifact
storage quota failure. Deletion stops further storage accrual but does not erase
usage already accrued during the billing period.
Hosted runners do not wait during private compilation. Stable Linux and Apple
Silicon macOS builds remain hosted, as do feature-branch diagnostic builds.

The scheduler and completion workflow live on `main`; the nightly workflow
explicitly checks out `staging` and passes its immutable SHA to every builder.
Fingerprint verification uses the requested source's policy in a child process
without credentials or dotenv loading, so different policies on `main` and
`staging` do not reject the same source. Legacy Linux-only requests remain
retryable while their artifacts are available. Updating these workflows does
not dispatch a compile: releases start only on the existing schedule, explicit
manual release dispatch, or stable release tag. Do not run those entry points
when deploying workflow maintenance alone.

Both repositories require an Actions secret named `LINUX_RELEASE_BRIDGE_TOKEN`:
a fine-grained token limited to these two repositories with Actions read/write
access. It permits workflow dispatch and artifact retrieval without incoming
SSH access. The private runner has no public pull-request trigger. If a private
build fails, inspect its run, then rerun it; its completion notification retries
verification. A failed public completion job can also be rerun using the original
source run ID and attempt while the artifacts remain available.

## Source-build prerequisites

Run `bun run desktop:doctor` from the repository root to check all build
requirements at once. It reports what is missing and the exact command to
install it.

- [Bun](https://bun.sh) ≥ 1.4.4 (also required by the server itself)
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
    gstreamer1.0-plugins-base gstreamer1.0-plugins-good squashfs-tools
  ```

  Fedora:

  ```bash
  sudo dnf install gcc gcc-c++ make curl wget file openssl-devel \
    webkit2gtk4.1-devel libappindicator-gtk3-devel \
    librsvg2-devel libxdo-devel gstreamer1 \
    gstreamer1-plugins-base gstreamer1-plugins-good squashfs-tools
  ```

  Arch Linux:

  ```bash
  sudo pacman -S --needed base-devel curl wget file openssl \
    webkit2gtk-4.1 libappindicator-gtk3 librsvg libxdo \
    gstreamer gst-plugins-base gst-plugins-good squashfs-tools
  ```

  Package names vary by distribution. `libayatana-appindicator3-dev` may be
  substituted with the distribution's `libappindicator` development package.
  The GStreamer plugin sets are copied into AppImage builds so WebKit's audio
  support does not depend on host plugins hidden by the AppImage launcher.
  `unsquashfs` from `squashfs-tools` verifies the finished AppImage's stored
  permissions; the runtime's extraction command creates private directories
  and does not preserve their packaged modes.
  The other packages are build dependencies; a machine running an unpackaged
  Linux binary also needs the matching AppIndicator runtime library.

  Optional at runtime: extension system-audio analysis on Linux uses `parec`
  (`pulseaudio-utils`, or `pipewire-pulse` on PipeWire systems). Without it the
  feature reports "unsupported" and nothing else changes.

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
outside a checkout starts unconfigured and opens the instance selector; use
**Browser → Instance Connection… → Existing checkout** to change the folder.

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
The finalizer also installs a pre-hook launcher that captures original host
environment values, enforces the graphics library policy, and records native
versions, build provenance, packaging tool hashes and runtime/helper hashes in
`usr/share/lumiverse/runtime-manifest.json`. External browser and folder launches
restore those values only in the child process. The packaged offline gate tests
real WebKit click/type/scroll input and a fake host URL handler, using software
compositing; it does not certify the proprietary GPU path. Other bundle formats
and platforms pass through unchanged.

Bundles land in `desktop/src-tauri/target/release/bundle/` (`.app`/`.dmg`
on macOS, `.exe` installers on Windows, and `.AppImage` on Linux).

## Automated releases

Bundled releases support Windows x64/ARM64 (NSIS `.exe`), Linux x64/ARM64
(`.AppImage` only), and macOS Apple Silicon/Intel (`.dmg`, plus the signed
`.app.tar.gz` used by the updater). Each includes the tested standalone server.

- **`desktop-nightly-scheduler.yml`** runs on `main` daily at 05:23 UTC and
  dispatches **`desktop-build.yml`** on `staging` with `bundled_nightly=true`.
  GitHub only evaluates cron on the default branch, so keep the scheduler on
  `main` and merge that change back into `staging`.
- **`desktop-nightly.yml`** prepares the bundled release from `staging`. It skips
  the build if bundled source matches the last successful nightly. A new build
  gets the next desktop patch version with `-nightly.<date>.<run>` appended.
- **`desktop-release.yml`** publishes stable `desktop-vX.Y.Z` tags from `main`;
  manual dispatch publishes the committed version from `main`. The tag must
  match the desktop manifests and stable versions must increase, including
  releases with only bundled server changes.
- Both call **`server-bundle.yml`**, which builds/tests all six native targets,
  uploads signed assets directly to a draft GitHub Release, and advances the
  selected channel feed only after every platform passes. Release payloads
  use version-pinned URLs. Existing published payloads are not replaced.
- **`desktop-build.yml`** retains checkout-based feature-branch installer tests
  and keeps their workflow artifacts for three days. `main` and `staging` use
  the bundled release cycle instead of running duplicate installer builds.
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

Configure the updater signing key before activating releases. The public key is
the repository variable or secret `LUMIVERSE_UPDATER_PUBLIC_KEY`; the private key and its
password belong in `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secrets. The public key is
compiled into the app. See [desktop updates](../developer-docs/docs/getting-started/desktop-updates.md)
for key setup, channel behavior, publication recovery, and storage policy.

## License

Lumiverse Desktop is covered by the project's
[Lumiverse Community License 2.1](../LICENSE.md). Cargo and the installer
configuration reference that canonical file; desktop bundles include it as
`LICENSE.md`. Third-party dependencies retain their own licenses.

## Self-contained staging build

The experimental bundled-server installer includes its own Bun server and
first offers a built-in server, an existing checkout, or a remote connection.
Choosing the built-in server
opens a three-step first-run wizard in a local Tauri window. Account,
server/storage, and review steps support Back navigation; Save and the folder
picker use native IPC callbacks. The tray owns the packaged server process.

After installing the repository, frontend, and desktop build dependencies:

```sh
bun run build:desktop-server
```

Intel Mac builds download the version-matched native engine first. Set
`GITHUB_TOKEN` to a token with repository read access, then run:

```sh
bun --no-env-file scripts/lancedb-macos-release.ts download
bun --no-env-file scripts/check-lancedb-macos.ts --artifact-dir dist/native/lancedb-darwin-x64
bun run build:desktop-server
```

Desktop release CI reuses the published dependency or a verified cache and tests
native database operations on the private Intel Mac. It compiles LanceDB only
when the matching build is unavailable; download errors fail rather than cause
an unnecessary rebuild. Hosted completion publishes the tested addon, manifest,
and upstream license as a versioned GitHub prerelease. These releases are
retained independently of desktop nightlies.

After changing the pinned LanceDB version/source, Rust toolchain, CPU baseline,
minimum macOS version, or release compilation profile, dispatch that dependency
workflow on trusted `main` or `staging` to build the dependency independently of
an app release. Those settings determine the release tag;
application changes and native-test edits reuse the existing binary. Bump
`INTEL_LANCEDB.buildRevision` for compilation changes not captured in those
settings. The workflow reuses an existing release or verified build cache before
compiling on the private runner, and cannot replace a published binary with
different bytes. A release build can also produce a missing dependency itself.

```sh
gh workflow run intel-lancedb.yml --repo prolix-oc/Lumiverse --ref main
```

An optional `seed_cache_key` migrates an existing validated build without
compiling; dispatch on the cache's owning branch. A missing migration cache fails
without starting a rebuild. For an intentional local source build, install
Xcode command-line tools, rustup, protobuf, and cmake, then run
`bun run build:lancedb:macos`.

The Intel installer includes LanceDB; end users do not need a Rust toolchain
or a separate database installation. Bundled macOS apps require macOS 13 or later.

For a clean debug run that preserves your regular desktop settings and remote
session, build the separate **Lumiverse Desktop Debug** app:

```sh
APPLE_SIGNING_IDENTITY=- bun run build:desktop-server --reuse-server --debug --bundles app -- --locked
open -n "desktop/src-tauri/target/debug/bundle/macos/Lumiverse Desktop Debug.app" --args --profile setup-test-1
```

Quit the debug app before restarting it with another profile. Reusing the name
resumes that test profile; a new name starts fresh without deleting anything.
Names accept 1–48 lowercase letters, digits, or hyphens. Debug builds have their
own app identity even without `--profile`; named profiles additionally isolate
settings, WebView storage, native OAuth credentials, and local server files.
The debug local server defaults to port 17860 and a data directory inside the
profile's app data. Its setup wizard can change those settings.

Use **Browser → Instance Connection…** to switch between remote and local.
Switching retains the last remote address and its saved credentials. Only the
explicit remote sign-out action removes the saved credential.

**Existing checkout** uses the folder's source runner, configuration, account,
and data, with the existing update and desktop rebuild controls. Browse to the
checkout and choose **Use existing checkout**; this path requires an installed
Bun runtime and the checkout's normal dependencies. It bypasses the built-in
owner setup wizard. If that checkout is already serving its configured port,
the app opens it instead of starting another server. Externally started servers
remain owned by their terminal or service.

Existing saved checkout selections continue automatically after installing a
bundled app. An explicit choice of the built-in server takes precedence, while
the saved checkout folder remains available for switching back. Select or change
a checkout through **Browser → Instance Connection…** in the tray. A clean debug
profile asks you to select its checkout explicitly; checkout reuse runs against
that folder's actual data, while built-in debug servers use isolated profile data.

To transfer a checkout's data to the built-in server, stop both servers and use
**Open Lumiverse Data Folder** in local mode to open the destination. Back up
the destination, then replace its contents with the entire old data folder,
including hidden files, `lumiverse.identity`, databases, and owner credentials.
Start the built-in server again and sign in with the old instance's account.
This action opens storage; it does not change the selected instance or checkout.

See the [bundled server guide](../developer-docs/docs/getting-started/bundled-server.md)
for staging downloads, supported architectures, storage, and acceptance tests.
