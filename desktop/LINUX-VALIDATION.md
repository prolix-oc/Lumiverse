# Linux desktop qualification

The October 16 audit lives at
[`developer-docs/plans/linux-desktop-2026-10-16.md`](../developer-docs/plans/linux-desktop-2026-10-16.md).
This implementation repairs confirmed layout, launcher, authorization, and
observability gaps. It does not establish a fix for proprietary NVIDIA rendering.

## Controlled graphics comparisons

Use the intact finalized AppImage and a fresh named profile. Quit the previous
process between runs. **Browser → Linux Graphics & Diagnostics…** saves
per-profile settings for the next launch and copies redacted runtime diagnostics.
It reports the actual GTK display type; session environment hints alone are not
backend evidence. The diagnostic opaque choice creates opaque browser/widget
surfaces and prevents native blur.

Backend precedence is `LUMIVERSE_GDK_BACKEND`, pre-AppRun user `GDK_BACKEND`
(including lists), saved backend, then the existing automatic policy. Pure
Wayland starts natively. Sessions offering X11 still retain the current default
until the native accelerated path passes the hardware matrix. A saved backend
whose display is absent is skipped when changing session types. There is no
automatic NVIDIA workaround based on kernel module presence or GPU enumeration.

Run these comparisons with the same account, theme and representative chat:

| Run | Backend | Rendering | Opaque |
| --- | --- | --- | --- |
| A0 | Automatic | Default | Off |
| A1 | Native Wayland | Default | Off |
| A2 | Native Wayland | NVIDIA: disable explicit sync only | Off |
| A3 | Native Wayland | NVIDIA: disable explicit sync only | On |
| D1 | Native Wayland | Disable DMABUF | Off |
| D2 | Native Wayland | Disable accelerated compositing | Off |

Explicit environment values win over saved rendering choices. Remove existing
fallback overrides for comparisons that require acceleration. The native
Wayland + explicit-sync comparison can also be launched with:

```sh
env -u WEBKIT_DISABLE_DMABUF_RENDERER -u WEBKIT_DISABLE_COMPOSITING_MODE \
  -u LIBGL_ALWAYS_SOFTWARE -u GALLIUM_DRIVER \
  LUMIVERSE_GDK_BACKEND=wayland __NV_DISABLE_EXPLICIT_SYNC=1 \
  ./Lumiverse.AppImage --profile linux-a2
```

## What automated checks establish

- Unit/process tests cover original environment restoration, unset/empty values,
  spaces, backend precedence, bounded browser dispatch, errors, callback state,
  cancellation/listener closure, and stale attempts and menu completions.
- Finalization preserves the tested Bun binary, existing GStreamer factories,
  readable/executable permissions and host Wayland-client boundary. It rejects
  bundled host GL dispatch/vendor libraries using
  [`linux-runtime-policy.json`](linux-runtime-policy.json).
- `usr/share/lumiverse/runtime-manifest.json` records source, native versions,
  Debian revisions, actual build OS/glibc, locked shell crates, packaging tool
  hashes and runtime library/helper hashes. Re-extraction verifies these hashes.
  The Ubuntu 22.04 / glibc 2.35 baseline remains unchanged. Apt repositories and
  upstream Tauri tool downloads are not made immutable by recording their hashes;
  freezing a coherent runtime/toolchain needs a separately qualified snapshot.
- The Xvfb gate uses software compositing in an offline namespace as another
  user. XTest events exercise typing, clicking and scrolling in a minimal
  packaged WebKit view. A fake host `xdg-open` checks the restored environment,
  working directory and dispatch. This does not open a real browser or test the
  full chat workload, Wayland, NVIDIA acceleration or mixed-DPI geometry.

## Implementation checks on October 16

On the macOS development host, 121 native Rust tests and 161 Bun tests passed,
including the launcher/process, authorization, capability and packaging
regressions. One real-SquashFS test was skipped because its Linux tools are
unavailable. The desktop production build, native `cargo check --locked`,
packaging TypeScript check, workflow YAML parsing, shell syntax and diff checks
also passed. Unix tests compile the portal implementation, but do not exercise
a real desktop portal. The new Linux CI/AppImage interaction gate and
Linux-specific GTK integration have not been executed on this host.

## Hardware and integration release gate

Do not mark the renderer regression resolved or promote a graphics-default /
runtime change until all of the following have recorded results:

1. KDE Wayland + NVIDIA (including Turing / the reported 615 driver when
   available); AMD and Intel Wayland controls; native X11; the oldest supported
   system. Record artifact SHA-256, source, runtime manifest, driver/egl-wayland,
   compositor, kernel, display layout, refresh rates and scale factors.
2. Test the three setup choices, errors and keyboard actions at 100%, 125%,
   150% and 200%, low effective resolutions and mixed-DPI monitor moves.
3. Run a representative chat for ten minutes and at least 100 move, resize,
   minimize, hide and show cycles. Record input latency, frame times, CPU/GPU
   behavior and X client/socket counts. Agree numerical budgets against the
   responsive native-browser baseline before promotion. Require no crash,
   freeze/white region, repeated native critical or unbounded connection growth.
4. Inspect `/proc/<pid>/maps` for the UI, WebKitWebProcess and
   WebKitNetworkProcess. Establish the actual EGL/GL renderer and presentation
   path with driver tools; a WebGL context or GPU process listing is insufficient.
   Compare a coherent distro-native build without deleting bundled libraries.
5. Use the intact AppImage with LAN HTTPS and a proxy-hosted instance. Test
   Opera cold and already running, a second browser, missing handlers, unavailable
   portals, denied/timed-out portal requests, callback success/denial, five-minute
   expiry, retry, cancel, instance switching, unavailable keyring and restart
   restore. Confirm a failed portal dispatch never opens a duplicate fallback.
6. If Error 71 persists, obtain a short `WAYLAND_DEBUG=1` trace identifying the
   violated object. For GLib criticals, capture the first-warning stack in a
   dedicated `G_DEBUG=fatal-warnings` run; for hangs, capture thread stacks.
   Review traces for private content before sharing them.

Nested compositor automation, a coherent runtime upgrade, packaging-tool snapshot
pinning and accelerated hardware qualification remain outstanding. No evidence
from this macOS implementation session supports selecting a new runtime or
enabling a global NVIDIA/software workaround.

Upstream references: [Tauri Linux graphics](https://v2.tauri.app/develop/debug/linux-graphics/),
[OpenURI portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.OpenURI.html).
The explicit acceleration choice uses `0` for unset WebKit disable flags, as
checked in the shipped WebKitGTK 2.50.4
[backing store](https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebKit/UIProcess/gtk/AcceleratedBackingStore.cpp)
and [acceleration manager](https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebKit/UIProcess/gtk/HardwareAccelerationManager.cpp).
