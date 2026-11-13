# Experimental bundled server

The standalone server is a single downloadable executable containing Bun, the
server, production dependencies, the built frontend, SQL migrations, and user
documentation. It does not need a checkout or a system Bun/Node installation.

The bundled desktop is published through versioned **stable** releases from
`main` and **nightly** releases from `staging`. Nightly builds run once daily
only when bundled source changes. Choose your OS and CPU on the desktop release
page: AppImage for Linux, NSIS installer for Windows, or DMG for macOS. Signed
in-app updates replace the desktop and included server together. See
[desktop updates](desktop-updates.md) for activation and release policy.

The standalone server remains available through `bun run build:server`; the
release pipeline builds and tests it before embedding it in the desktop. It
does not also upload the large standalone executable as an Actions artifact.
Native build output names are:

| System | Artifact |
| --- | --- |
| Apple Silicon Mac | `lumiverse-server-darwin-arm64` |
| Intel Mac | `lumiverse-server-darwin-x64` |
| Linux x64 | `lumiverse-server-linux-x64` |
| Linux ARM64 | `lumiverse-server-linux-arm64` |
| Windows x64 | `lumiverse-server-win32-x64` |
| Windows ARM64 | `lumiverse-server-win32-arm64` |

Intel Mac builds include our version-matched LanceDB native addon, compiled
from the pinned upstream source rather than an npm prebuild. macOS bundles
require macOS 13 or later; Intel CPUs must meet Bun's SSE4.2 requirement.
Linux builds target glibc. Each artifact is
built and smoke-tested natively on its own architecture. These are experimental
builds. Updater payloads are signed with the configured release key; macOS still
uses ad hoc application signing without Apple notarization. Desktop installers
include the tested executable as a Tauri sidecar and provide the complete
first-run flow inside the app.

## First launch

Extract the downloaded artifact. On macOS/Linux, make the server executable once
with `chmod +x ./lumiverse-server-*`. Launch the executable. It opens a local setup
page in your default browser. A three-step wizard covers the owner account,
server/storage settings, and a review of your choices. Back preserves your
earlier input so you can edit it before saving. The default
accepts connections only from this computer. When startup finishes, the setup
page opens Lumiverse automatically.

With a bundled desktop installer, launch **Lumiverse Desktop** instead. First
choose **Built-in server**, **Existing checkout**, or **Remote instance**.
Remote connects using the existing desktop sign-in flow without starting a
local server. Built-in opens the
wizard in its own local Tauri webview, including a native data-folder
picker. Save uses a Rust IPC callback and a private pipe to the bundled server;
desktop setup does not open a browser or a setup HTTP listener. Once the
server is ready, the integrated Lumiverse window opens and setup closes. The
tray owns server start/stop, and quitting the app stops the server and workers.
Use **Browser → Instance Connection…** to change modes later. The last remote
address and native OAuth credential survive a switch to local, so returning to
remote restores the saved session when it is still valid. Explicit remote
sign-out removes that credential.

**Existing checkout** lets you select a Lumiverse folder with a native picker.
The desktop uses that folder's source runner, `.env`, account, and data, and
keeps the existing Git update and desktop rebuild controls. This path requires
an installed Bun runtime and the checkout's usual dependencies. It does not
run the built-in owner setup wizard. A server already running at the checkout's
configured port is reused and stays owned by the terminal or service that
started it. Servers launched by the app stop when it quits or changes instance.

Saved checkout selections from earlier desktop installations take precedence
over the included server, so upgrading keeps the existing local setup. Choosing
the built-in server explicitly overrides that default while retaining the
checkout folder for later. Select or change the checkout through
**Browser → Instance Connection… → Existing checkout**. A clean debug profile needs its own folder
selection; checkout reuse uses the selected checkout's actual data rather than
creating an isolated copy.

**Open Lumiverse Data Folder** opens the selected local server's actual data
directory in the system file manager. It is disabled in remote mode and works
while the local server is stopped, including with a custom data directory or
isolated debug profile. If the folder does not exist yet, it creates an empty
directory without starting the server or setting up an account.

To move an existing checkout's data into the built-in server, stop both servers,
open the destination with that tray action, and back it up. Replace its contents
with the entire source data folder, including hidden files, `lumiverse.identity`,
databases, and owner credentials, then start the built-in server and sign in with
the old account. Copy the folder's contents into the destination, rather than
creating another nested `data/` directory. Checkout `.env` settings remain
separate; server port and network settings can be chosen in the setup wizard.

If the host has no browser, launch with `--no-open` and visit the printed setup URL
on that computer. The first-run listener always binds to `127.0.0.1`, independently
of the server's eventual network setting. Keep the setup link private while it
is active; it contains a short-lived setup token. Account passwords are stored
only as hashes, using the same credentials format as checkout installations.

The terminal owns the server process. Ctrl+C stops it and closes its database
and workers. Running the executable again uses the saved settings and account.
To update, stop the server and replace the executable with a newer artifact;
the data and configuration directories survive the replacement. The source
runner's Git update/branch-switch controls are not part of this distribution.

## Storage and configuration

| System | Settings | Instance data | Extracted runtime cache |
| --- | --- | --- | --- |
| macOS | `~/Library/Application Support/Lumiverse/server.json` | `~/Library/Application Support/Lumiverse/data` | `~/Library/Caches/Lumiverse/server/<build>` |
| Windows | `%LOCALAPPDATA%\Lumiverse\server.json` | `%LOCALAPPDATA%\Lumiverse\data` | `%LOCALAPPDATA%\Lumiverse\Cache\server\<build>` |
| Linux | `$XDG_CONFIG_HOME/lumiverse/server.json` | `$XDG_DATA_HOME/lumiverse/data` | `$XDG_CACHE_HOME/lumiverse/server/<build>` |

Linux defaults to `~/.config`, `~/.local/share`, and `~/.cache` when XDG variables
are unset. The first launch expands the application into its cache, requiring
more disk space than the download. Later launches reuse that build. Cached
application files are separate from instance data; back up the entire data
folder, including the encryption identity. Old runtime caches can be removed
when their server processes have stopped.

Useful options, also listed by `--help`:

```sh
./lumiverse-server-linux-x64 --data-dir /path/to/existing/data
./lumiverse-server-linux-x64 --port 7861 --no-open
./lumiverse-server-linux-x64 --env-file /path/to/server.env
./lumiverse-server-linux-x64 --check
./lumiverse-server-linux-x64 --reset-password
./lumiverse-server-linux-x64 --print-data-dir
```

`--config-dir` and `--cache-dir` override their respective directories. The
equivalent variables are `LUMIVERSE_CONFIG_DIR` and `LUMIVERSE_CACHE_DIR`.
Data/port/host precedence is command-line option, environment (`DATA_DIR`, `PORT`,
`LUMIVERSE_HOST`), saved settings, then defaults. Environment files load only
when explicitly selected with `--env-file`; existing environment variables win.
The file uses dotenv syntax without shell expansion. A supplied `OWNER_PASSWORD`
and optional `OWNER_USERNAME` support unattended first-time provisioning without
opening the setup page. They never replace an existing account.

Use `--data-dir` to adopt an existing instance. Its owner credentials or database
users bypass account setup. `--reset-password` uses the selected data directory.
`--print-data-dir` returns the effective absolute data path as a JSON string,
without extracting the runtime, initializing storage, or starting the server.

`--check` uses disposable data to verify Sharp/libvips, LanceDB writes and
vector searches, persisted IVF/full-text indexes and reopening, SQL migrations,
database subprocesses, a regex worker, frontend/docs assets, the embedded Bun
CLI, an extension build/subprocess, and bundled FFmpeg when available. It never
opens or migrates the selected instance's database.

The core server runs without external tools. Git-based extension installation
still requires Git; extensions and MCP servers may require their own programs.
SMART monitoring uses `smartctl`. FFmpeg is included where `ffmpeg-static`
provides a binary; Windows ARM64 currently uses a system FFmpeg if available.

## Build and test

Use the pinned Bun version and build on the destination operating system and
architecture so native dependencies match the runtime:

```sh
bun install --frozen-lockfile
cd frontend
bun install --frozen-lockfile
cd ..
bun run build:server
bun run test:server-bundle
```

On Intel macOS, build the native addon before building the server or desktop:

```sh
# Build prerequisites: Xcode command-line tools, rustup, protobuf, and cmake.
brew install protobuf cmake
bun run build:lancedb:macos
bun run build:server
bun run test:server-bundle
```

The native builder checks out LanceDB 0.37.1 at a pinned commit, uses its pinned
Rust 1.97.0 toolchain and Cargo lockfile, and builds `x86_64-apple-darwin` for
macOS 13 with a conservative `x86-64` CPU target. It installs the required Rust
toolchain/target through rustup. Release compilation uses ThinLTO and four jobs
by default; `CARGO_BUILD_JOBS` can reduce memory use on the build machine. These
tools are build prerequisites; users of the packaged app need none of them.
The builder uses Apple's strip tool to avoid a Rust/LLVM Mach-O stripping issue
on macOS 27.

The output is `dist/native/lancedb-darwin-x64/`, containing the native `.node`
file, license, and a manifest recording the source, compiler, CPU/macOS target,
and SHA-256 checksum. Packaging verifies the version, checksum, architecture,
and macOS minimum before copying the addon next to LanceDB's normal loader.
Workers and subprocesses use that same module without a runtime download.
Changing the LanceDB npm version requires updating the source pin and rebuilding.
`build:server --lancedb-native-dir PATH` can use an artifact built elsewhere.

The source builder also accepts `--source-dir PATH` for an existing upstream
checkout; it archives the pinned commit, excluding local patches and generated
files. Apple Silicon can cross-build the addon, but building and testing the
complete Intel server/installer runs on the `macos-15-intel` CI runner. The
workflow tests the native engine and the extracted server before publishing the
Intel desktop installer. The native source provenance and license travel with
the embedded engine; separate native/standalone Actions artifacts are omitted
to avoid retaining duplicate large payloads.

An existing Intel checkout with the same LanceDB version can use that tested
native artifact produced by `build:lancedb:macos` through the existing `.env` override:

```dotenv
LUMIVERSE_LANCEDB_NATIVE_PATH=/absolute/path/to/lancedb.darwin-x64.node
```

The checkout still needs its usual Bun/dependencies. Packaged apps choose the
included native library automatically.

To package the same feature in a desktop installer, install `desktop/`
dependencies and the usual Tauri build prerequisites, then run:

```sh
bun run build:desktop-server
# Reuse an already built/tested server during development:
bun run build:desktop-server --reuse-server
# Build a debug macOS application for local testing:
APPLE_SIGNING_IDENTITY=- bun run build:desktop-server --reuse-server --debug --bundles app -- --locked
# Launch a clean profile while keeping the regular desktop session:
open -n "desktop/src-tauri/target/debug/bundle/macos/Lumiverse Desktop Debug.app" --args --profile setup-test-1
```

Bundled debug builds also merge `tauri.debug-profile.conf.json`, giving them the
separate name **Lumiverse Desktop Debug** and identifier
`chat.lumiverse.tray.debug`. A `--profile NAME` argument gives any desktop build
an additional storage namespace. Names allow 1–48 lowercase letters, digits,
or hyphens. Quit the debug app before changing profiles. Reusing a name restores
its settings; using a new name exercises first launch without clearing files
or touching the regular desktop session.

Isolated profiles use separate settings, native OAuth credential services,
and WebView storage. Bundled servers also use separate configuration/data/cache.
On macOS 14 and
later, each profile has its own persistent WebView store; older macOS versions
use a private WebView session. A debug local server defaults to port 17860,
with its files under the profile's app data directory in `local-server/`.
For example, the macOS profile above uses
`~/Library/Application Support/chat.lumiverse.tray.debug.profile.setup-test-1/local-server/`.
The wizard can choose a different port or data folder and retains that choice
on subsequent launches. Login-at-startup controls are disabled in isolated
profiles so testing does not change the regular app's startup setting.

The build stages the executable using Tauri's target-triple naming and merges
`desktop/src-tauri/tauri.server-bundle.conf.json`. It produces installers in
the normal desktop target/bundle directory. Setup callbacks are granted only
to the local `server-setup` webview, with a narrow Vite-origin exception for
development; remote frontends and extension windows cannot configure it.

Outputs are under `dist/server/`: an executable, build metadata, and a SHA-256
checksum. `--outfile PATH` chooses a different executable path.
`--skip-frontend-build` reuses an already built frontend during development.
`--offline` requires all production packages in Bun's cache and an installed
`ffmpeg-static` binary for supported targets.

The build installs production dependencies in a temporary staging directory
using the committed lockfile. It explicitly copies application sources/assets,
not `.env`, instance data, Git metadata, or desktop build outputs. An embedded
gzip archive preserves the existing module layout, including worker and
subprocess entrypoints and native-library search paths. A small Bun-compiled
launcher verifies and extracts that archive atomically into a content-addressed
cache. Concurrent launches can share a completed extraction.

The archive also includes the pinned plain Bun executable. Cached `bun` and
`node` aliases support subprocesses and extension build commands without a
system runtime. A system Node installation takes precedence over the optional
Node compatibility alias. Using a plain runtime avoids globally setting `BUN_BE_BUN=1`,
which would change the behavior of third-party Bun-compiled MCP programs. This
keeps the existing process isolation and dynamic extension loading. The first
version prioritizes correct packaging over bundling every server module into
one JavaScript chunk.

The acceptance script runs from a fresh directory outside the checkout with an
empty `PATH`. It checks native loading and workers, completes GUI setup, signs
in, serves frontend/docs assets, writes through the API, stops gracefully, and
restarts using the saved account and settings. It also drives the native setup
callbacks, checks that the password never appears in stdout, signs in with the
configured account, restarts without setup, and closes the parent's pipe to
verify process cleanup. CI packages each desktop with that platform's tested
server executable.

References: [Bun standalone executables](https://bun.sh/docs/bundler/executables),
[Bun archives](https://bun.com/docs/runtime/archive), and
[Tauri sidecar packaging](https://v2.tauri.app/develop/sidecar/).

For a Bun-managed sidecar, the launcher emits `{ type: "lumiverse-ready", url }`
over its parent's IPC channel. The parent can send `{ type: "lumiverse-shutdown" }`
to request database/worker cleanup, including on Windows. Losing that owning
IPC connection also stops the server. The Rust desktop host uses the equivalent
authenticated stdio channel, including graceful shutdown on stdin EOF.
