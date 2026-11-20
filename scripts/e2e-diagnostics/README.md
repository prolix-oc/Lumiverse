# Lumiverse browser diagnostics

Uses Playwright to open a live Lumiverse instance, log in, and run targeted diagnostics against chat pages and Spindle extensions.

## Setup

```bash
cd scripts/e2e-diagnostics
bun install --frozen-lockfile
bun run browsers:install
bun run browsers:check
```

Playwright is pinned to 1.64.1; use this package's install command so browser binaries match the library. `browsers:check` verifies launch, rendering and input in Chromium, Firefox and WebKit. The shared launcher used by the PWA/HMR checks and Vite benchmark gives macOS Firefox fresh test app data as well as its temporary profile, avoiding access to the protected personal Firefox data directory ([Mozilla's profile-startup issue](https://bugzilla.mozilla.org/show_bug.cgi?id=2069536)). The launcher cleans up that test data when the browser closes.

## Run

Create a `.env` file (see `.env.example`) or export the variables:

```bash
export LUMIVERSE_URL=https://my.lumiverse.app
export LUMIVERSE_USER=admin
export LUMIVERSE_PASS="your-password"

bun run diagnose
```

## Scripts

- `node check-runtime-message-mutations.mjs`
  Exercises the production chat store and WebSocket callbacks with controlled events in Chromium, Firefox and WebKit at desktop/mobile widths. Checks insertion during continuation, role edits, stale tail responses and pagination after insertion into unloaded history. Requires frontend dependencies and matching browsers; no backend, credentials or personal data.

- `bun run check:st-preset-import`
  Exercises SillyTavern file import, exact and duplicate identifiers, editor save/reload, mouse and keyboard reorder, category detach/append, and portable/ST exports at desktop/mobile widths in Chromium, Firefox and WebKit. Uses the real Loom UI, validation and API client with controlled persistence and profile state. Requires frontend dependencies and matching browsers; no live account or personal data.

- `node check-connection-recents.mjs`
  Exercises the real Display settings checkboxes, persistence, all six connection kinds, quick picker, full picker variants A/B/C and persona manager in Chromium, Firefox and WebKit at desktop/mobile widths. Checks the default for existing accounts, hide/show after reload, selection and embedding models while hidden, retained history when re-enabled, and independent persona visibility without removing canonical cards. Uses the real store with isolated HTTP settings storage; no backend, credentials or personal data. `CONNECTION_BROWSERS=chromium` selects an engine.

- `node check-image-provider-settings.mjs`
  Exercises the actual Generation Settings modal with controlled connections in Chromium, Firefox and WebKit at desktop/mobile widths. Covers all 18 new providers, model-specific source-image restrictions, reference addition/removal and runtime errors (144 provider/model/viewport/browser cases). No backend, credentials or paid provider calls.

- `bun run check:vite-hmr`
  Runs the real app and native card in a temporary copy of frontend source, with mock API responses and actual file-watcher edits. Makes two edits each to login, the character card, and character/message-preview/world-book/productivity renderer modules using the standard Vite configuration and the unbundled fallback (72 edits total). Checks retained form/hook state, store identity, registration availability, updated callbacks and detached navigation, with no full reloads or runtime errors. Defaults to Chromium, Firefox and WebKit; `HMR_BROWSERS=firefox` and `HMR_MODES=default` narrow the matrix; `HMR_MODES=bundled` explicitly forces bundling. Install frontend dependencies first. Scratch copies and dependency caches under `frontend/.tmp/vite-hmr/` are removed after each mode. No backend, credentials or personal data.

- `bun run bench:vite`
  Measures the real app's login startup and full reloads in unbundled and bundled Vite development mode. Uses isolated API responses, a fresh dependency cache/browser per cold sample, and three alternating samples per mode. Install frontend dependencies and run `bun run browsers:install` first. Results and logs go to `frontend/.tmp/vite-dev-benchmark/`. This measures loading; `check:vite-hmr` covers hot edits. Bundled dev is the frontend default; `bun run dev:unbundled` selects the fallback.

- `bun run bench:cache`
  Builds the real app/PWA four times to compare builds with and without chunk import maps before and after one French translation change. The change is applied in memory; builds and estimated replacement-asset totals go to `frontend/.tmp/chunk-cache-benchmark/`. Install frontend dependencies first. This excludes the worker itself and estimates gzip size, rather than measuring network transfer.

- `bun run bench:compiler`
  Builds the real character and pack cards in production with the Compiler off, Babel, and the native Compiler. Measures 30 synchronous updates to 60 cards of each kind, with stable actions and with actions replaced by the parent. Each of seven alternating samples gets two warm-up runs; assertions check current callbacks and actual image render counts. The fixture instruments `LazyImage` in memory and uses local image responses. Results go to `frontend/.tmp/react-compiler-benchmark/results.json`; temporary builds are removed. Install frontend dependencies and matching Chromium first. Run without concurrent builds for comparable timings. This measures controlled render/commit work, not whole-app responsiveness, scrolling, network or image decoding.

- `bun run check:profile-transitions`
  Exercises the real character profile, store, translations and rich content renderer with isolated API data. Checks scoped 160ms React ViewTransition snapshots, keyboard tabs, retained expanded profile sections, rich-media teardown, and reset when switching characters. Covers animated, reduced-motion, efficiency and unsupported-browser cases at desktop/mobile widths in Chromium, Firefox and WebKit. `PROFILE_BROWSERS=chromium` narrows the matrix. Screenshots go to `frontend/.tmp/profile-transitions/`. Install frontend dependencies and matching browsers first. No backend, credentials or personal data; physical native WebViews still need device qualification.

- `bun run check:pwa-build`
  Checks actual production bundles with mock API responses, fresh browser profiles, worker installation and offline reload, then mounts the authenticated application shell with bootstrap/settings hydration. First run `bun run build:checked` from `frontend/`, then install browsers here with `bun run browsers:install`. The default build directory is `frontend/dist`, which now uses native compilation and import maps. Defaults to Chromium, Firefox and WebKit; `PWA_BUILD_BROWSERS=chromium` selects an engine. Positional arguments can select other build directories. Use `check:pwa-upgrade` for installed-worker updates. Physical native WebViews require device testing. No backend, credentials or personal data.

- `bun run check:pwa-upgrade`
  Builds legacy Babel/no-map, standard native/import-map and changed-locale native/import-map generations under `frontend/.tmp/pwa-upgrade/`. Deploys them in sequence at one local origin using production cache headers and the actual worker, retaining the installed browser profile. Chromium, Firefox and WebKit check one guarded automatic reload per deployment, retained preferences, cached map alignment, offline reload and lazy French/German locale loading. The second deployment changes a real French login label in memory and checks the updated content. The fixture ages the reload-guard timestamp between deployments to simulate later updates. `PWA_UPGRADE_BROWSERS=chromium` narrows the matrix. No backend, credentials, source edits or personal data.

- `node check-ui-language.mjs`
  Start the frontend Vite server in unbundled mode first (`cd frontend && bun run dev:unbundled`), so Vite serves the test fixture instead of the application entry point. Exercises real login, password recovery, lazy locale chunks, authentication and account settings with isolated HTTP responses. Checks login-language reload persistence, immediate account saves, a second device, settings refresh, account isolation and the one-time English default at desktop/mobile widths in Chromium, Firefox and WebKit. No live accounts or personal data. `UI_LANGUAGE_URL` selects the Vite origin; positional arguments select browser engines.

- `node check-chat-image-presentation.mjs`
  Exercises the real image settings, message renderer and attachments with controlled preferences and image responses. Covers all eight combinations of Markdown/asset, HTML/XML and attachment selection (including all unchecked), checkbox keyboard input and reload persistence, Default/100%/75%/50%, left/center/right alignment, Markdown and linked/empty-alt images, raw/self-closing HTML, asset references, isolated HTML and both attachment styles. Checks proportions, unchanged video layout, spacing between customized image attachments, keyboard selection, close/reopen and reload persistence, remount, profile-preview isolation and canonical safe-top containment at desktop/iPhone-sized widths and UI scales 1/1.25 in Chromium, Firefox and WebKit. Uses the shared minimal/bubble content styles; it does not replace a human live-environment audit or physical installed-PWA testing. No account or personal data. `IMAGE_BROWSERS` selects engines; `IMAGE_SCOPES_ONLY=1` runs the focused type-selection matrix; `PLAYWRIGHT_MODULE` and `PLAYWRIGHT_BROWSERS_PATH` can select an existing installation. Pass `--serve` for a review fixture.

- `node check-background-swipe.mjs`
  Uses the native swipe controls and streaming store with controlled generation events. Checks background generation, Ctrl/Cmd-click, keyboard activation, unchanged selected text, completion navigation, and ordinary-click behavior at desktop and iPhone widths in Chromium, Firefox and WebKit. No backend, credentials or personal chats are used. `SWIPE_BROWSERS` selects engines.

- `node check-message-preview.mjs`
  Exercises the real native message-preview surface, display hooks, resolver registry and regex pipeline with controlled store/HTTP boundaries. Covers owned resolvers and backend display regex, exact source ranges, swipe changes, disabled regex actions, HTML-island disclosures, navigation, source removal and remount. Runs desktop and notched-iPhone-sized layouts in Chromium and WebKit without a live server, credentials or personal data. `PREVIEW_BROWSERS` selects engines; `PLAYWRIGHT_MODULE` can point to an existing installation. Pass `--serve` for a human-review fixture. This does not emulate a physical installed PWA or substitute for the required human live-environment audit.

- `node check-drawer-width.mjs`
  Exercises the real sidebar width settings controls in the settings layout with controlled persisted state. Checks Default/Custom selection, clearing drag overrides, pointer and keyboard slider input, range boundaries, close/reopen and reload persistence, and containment below the canonical safe-top area. Runs desktop and notched-iPhone-sized viewports at UI scales 1 and 1.25 in Chromium, Firefox and WebKit. No server or personal settings are used. Set `DRAWER_WIDTH_BROWSERS=chromium` for one engine; `PLAYWRIGHT_MODULE` can point to an existing Playwright installation. This checks the settings surface; it does not run the full drawer or emulate a physical installed PWA.

- `node check-spindle-touch-scroll.mjs`
  Audits the real installed-iOS document guard and Spindle widget policy with synthetic touch events in Chromium, Firefox and WebKit, at desktop and notched-iPhone viewport sizes. Checks default guarding, opt-in, isolation from core and nested widgets, shadow content, reversal and root teardown. No server, credentials or user data. This tests cancellation decisions, not physical installed-PWA scrolling.

- `node check-world-book-workspace.mjs`
  Bundles the real native book modal, entry list and editor with controlled API/store boundaries. Covers same-instance maximize/restore, independent collapsed navigation, cross-folder/session tabs, keyboard tab switching, two-editor split/swap/close, mobile open-entry switching and Books views, keyboard-height layout, 0/1/44/50/137-entry books, exact tag filtering and vector failure indicators. Also checks activation method/status/chance transitions, vector recursion restrictions, keyboard focus, equal timing columns, Group Name/Weight proportions, equal UID/Automation dimensions, a read-only UID, compact organization rows and horizontal containment (including long untranslated labels). Checks desktop Books/Entries pointer and keyboard resizing, scaled collapse thresholds, focus restoration, pointer cancellation, Escape without closing the modal, before-paint mobile book-header hiding/restoration, and shared organization/detail backgrounds under light and dark theme variables. Runs desktop/mobile at UI scales 1 and 1.25 in Chromium, Firefox and WebKit without login or personal data. Also renders the actual inline compact entry list in the real sidebar scroll-panel styles at widths 320/440/560px and scales 1/1.25: expanded Injection/Activation field heights, wheel scrolling over the form, activation selection and disclosure draft retention. Set `SIDEBAR_ONLY=1` to run those 18 cases alone. Set `WORKSPACE_BROWSERS=chromium` for one engine; `PLAYWRIGHT_MODULE` can point to an existing Playwright installation. This checks core behavior; it does not emulate an installed Suite extension or a physical mobile keyboard.
- `node check-world-book-reorder.mjs`
  Exercises All entries on a controlled 251-entry book in the real workspace and sidebar. Checks keyboard and pointer ordering across the former 200-entry boundary, complete revision-guarded payloads, handle focus, editor mount guards, switching back to pagination, saved preferences after remount and search disabling reorder. Also checks preview geometry inside a transformed sidebar, pointer tracking after deep scrolling, a single visible drag preview, source restoration after drop/cancel and row-render counts at pickup and movement. Runs desktop/iPhone-sized layouts at scales 1 and 1.25 in Chromium, Firefox and WebKit. Set `REORDER_BROWSERS=chromium` for one engine; `PLAYWRIGHT_MODULE` can point to an existing Playwright installation. No login or personal data.
  For a focused performance comparison, run from the repository root in PowerShell:

  ```powershell
  $env:REORDER_BROWSERS = 'chromium'
  $env:REORDER_BENCHMARK = '1'
  $env:REORDER_WITHOUT_MEMO = '1'
  node scripts/e2e-diagnostics/check-world-book-reorder.mjs
  $env:REORDER_WITHOUT_MEMO = '0'
  node scripts/e2e-diagnostics/check-world-book-reorder.mjs
  ```

  The first run disables row memoization in memory without editing source. Token-cell renders measure row-content work: the 251-entry fixture measured 1,009 at pickup and 1,545 during pointer movement without memoization, versus 2 and 2 with it. Counts can vary with browser scheduling.
- `node check-world-book-search.mjs`
  Exercises ranked search in the real native workspace and sidebar with controlled entries. Checks folder card layout, touch targets, visible keyboard focus and folder activation, plus an exact title beyond the first server page, relevance before result pagination, highlights, typo matching, Escape/focus, returning from the editor, empty results and clearing back to ordinary navigation. Runs desktop/mobile widths at UI scales 1 and 1.25 in Chromium, Firefox and WebKit. Set `SEARCH_BROWSERS=chromium` for one engine; `PLAYWRIGHT_MODULE` can point to an existing Playwright installation. No login or personal data.
- `node check-entry-organization.mjs`
  Exercises native folder/tag controls inside the real modal shell using controlled in-memory data. Covers mouse/keyboard, focus, Escape, close/reopen, additive tags, folder removal, desktop/mobile widths and UI scales in Chromium, Firefox and WebKit. No backend, login or personal lorebooks are used. Set `ENTRY_ORGANIZATION_BROWSERS=chromium` for one engine; `PLAYWRIGHT_MODULE` can point to an existing Playwright installation.
- `node check-ui-scale.mjs`
  Runs a local React 19 scaling regression suite in Chromium, Firefox, and WebKit,
  with no server or login required. Install the frontend dependencies and run
  `bun x playwright install chromium firefox webkit` here first. Set
  `UI_SCALE_BROWSERS=chromium` to run one engine. See [UI scaling](../../developer-docs/docs/frontend-api/ui-scaling.md).
- `node check-expanded-editor-caret.mjs`
  Checks the real expanded editor with font scales 0.85–2, combined UI scaling,
  desktop/mobile widths, highlighted/plain text, and inline/modal layouts in
  Chromium, Firefox and WebKit. Verifies matching wrapping widths, native caret
  placement and typing after scrolling, including live scale and content changes.
  No server or login required. Set `EDITOR_BROWSERS=webkit` or pass
  `--browsers=webkit` to focus on the macOS desktop engine.
- `bun run diagnose`
  Captures general chat scroll and virtualization stats on the busiest recent chat.
- `bun run diagnose:spindle`
  Runs a generic Spindle extension sweep against a chat page or custom target route and captures extension logs, websocket traffic, root snapshots, screenshots, and optional button probes.

## Frontend UUID diagnostics

Run `node scripts/e2e-diagnostics/check-spindle-uuid.mjs` from the repository root. It exercises the real frontend UUID helper on a non-loopback HTTP origin where `crypto.randomUUID` is unavailable, at desktop and iPhone-sized viewports in Chromium, Firefox and WebKit. Checks synchronous draft creation, UUID format and uniqueness, unload, and remount without a backend, credentials or personal data. Set `UUID_BROWSERS=chromium` to select one engine. Actual loader wiring and stale-generation rejection are covered by the isolated loader lifecycle tests.

## Generic Spindle diagnostics

By default, the generic Spindle harness opens the busiest recent chat and inspects all enabled extensions returned by `/api/v1/spindle`.

```bash
export LUMIVERSE_URL=https://my.lumiverse.app
export LUMIVERSE_USER=admin
export LUMIVERSE_PASS="your-password"

bun run diagnose:spindle
```

Useful options:

- `LUMIVERSE_CHAT_ID`
  Force a specific `/chat/:id` target instead of auto-selecting a chat.
- `SPINDLE_TARGET_PATH`
  Open an arbitrary path like `/chat/<id>` or `/settings`, or a full URL.
- `SPINDLE_EXTENSION_FILTER`
  Comma-separated identifier/name/id filter, for example `lumirealm,lorebooks`.
- `SPINDLE_SETTLE_MS`
  Extra post-load wait before capturing diagnostics. Defaults to `5000`.
- `SPINDLE_CAPTURE_MANIFESTS`
  Set to `0` to skip per-extension manifest fetches.
- `SPINDLE_PROBE_ALL_VISIBLE_ROOTS=1`
  Click visible buttons inside every mounted visible extension root and capture deltas.
- `SPINDLE_ROOT_PROBE_PLAN`
  Probe only specific extensions/buttons. Format:

```bash
export SPINDLE_ROOT_PROBE_PLAN='extensionslug=Open settings|Select;my-extension=__ALL__'
```

Probe output includes:

- `summary.json`
  Cross-extension counts, race-signal summary, and per-extension rollups.
- `diagnostics.json`
  Full console/page/network/websocket/root probe capture.
- screenshots for the whole page, visible extension roots, and any probed states.

The summary highlights one class of frontend race directly: extension frontend messages that arrived before the app logged `[Spindle] Loaded frontend: ...`.

## Chat memory and rendering telemetry

`bun run diagnose` now samples memory and responsiveness during the scroll gesture.
It uses full Chromium's newer headless mode by default. The report records the
actual GPU renderer and acceleration status; hardware acceleration depends on the
host. Set `DIAG_BROWSER_CHANNEL=headless-shell` to select the older lightweight
shell, or `DIAG_HEADED=1` to show the browser.

```bash
# Lightweight memory, DOM, layout/task counters and callback cadence
bun run diagnose

# Also save a Chromium performance trace with before/after GPU memory dumps
DIAG_GPU_TRACE=1 bun run diagnose
node analyze-trace.mjs performance-trace.json

# Controlled regression checks; no account or live backend needed
bun run check:telemetry
```

Options:

- `DIAG_SAMPLE_MS`: sample interval, default `500`, range `100`–`10000`.
- `DIAG_SETTLE_MS`: wait after messages appear, default `2000`.
- `DIAG_SCROLL_WAIT_MS`: wait for each scroll direction, default `1500`.
- `DIAG_GPU_TRACE=1`: opt into the more expensive trace and memory dumps.

`report.json` retains `stats`, `diag`, `metricsBefore`, `metricsAfter` and
`metricDelta`, and adds `beforeStats`, `schemaVersion: 2` and `telemetry`.
`telemetry.json` contains the same standalone telemetry report. Raw CDP durations
remain in seconds in `metricsBefore`/`metricsAfter`/`metricDelta`; derived
`telemetry.counterDelta` durations are explicitly labeled in milliseconds.
`metricDelta` now includes supported work counters and memory/DOM gauges rather
than subtracting unrelated navigation timestamps. Invalid counter comparisons
after navigation or a reset are `null`, with reasons in the telemetry report.

Heap summaries distinguish JS heap, embedder heap and backing storage, with
before/after values and sampled peaks. These components are not a total RAM
measurement. DOM/listener counters cover the renderer, including objects awaiting
collection. Samples are bounded, polling does not overlap, and peaks continue to
update after the raw-sample limit. Recording stops after two minutes in the chat
diagnostic. `diag.rafCount` now counts the collector's callbacks rather than
application rAF requests. Callback intervals describe scheduling cadence, not
presented FPS. Percentiles use retained interval samples; totals/maxima keep
updating when the sample limit is reached. Long task, long animation frame and
layout shift support is reported explicitly.

With GPU tracing enabled, `performance-trace.json` can be opened in Chrome
DevTools or Perfetto. `telemetry.trace.gpuMemory.checkpoints` reports the GPU
process's root allocator size without summing shared or nested allocations.
These are browser-wide Chromium allocation bytes, not physical VRAM residency,
GPU utilization or memory owned by one extension. Missing values are `null`.
Clock markers bound each requested dump because Perfetto can rewrite dump IDs
when exporting JSON. Missing or ambiguous checkpoint records remain unavailable.
Memory dumps happen outside the browser collector's responsiveness window, but
tracing itself adds overhead: compare runs using the same recording options.
Traces have a 64 MiB recording buffer and a 128 MiB export limit; failures or data
loss are reported, and an interrupted export may leave a `.partial` file. Raw
traces can contain script URLs and other page metadata; review them before sharing.

For manual measurements, paste `telemetry-browser.iife.js` into DevTools:

```js
__LUMIVERSE_PERF__.start({ label: 'panel lifecycle' })
// Open, use and close the extension's UI several times.
__LUMIVERSE_PERF__.mark('panel closed')
await __LUMIVERSE_PERF__.stop()
__LUMIVERSE_PERF__.download()
```

This console-only collector works without Playwright. It reports supported
responsiveness signals and a coarse `performance.memory` heap estimate where
available; CDP memory/GPU measurements require the automated collector. Console
recordings default to 60 seconds and can be released with
`__LUMIVERSE_PERF__.dispose()`. The generic Spindle sweep has not been wired to
the collector yet. For regression comparisons, use the same browser, rendering
backend, data and action sequence; repeat open/close cycles in one document.

## Output

Results are written to `out/`:

- `report.json` — message-list stats, browser responsiveness records and sampled memory/DOM/Performance telemetry before/during/after the scroll gesture.
- `telemetry.json` — standalone telemetry, capabilities, rendering environment and optional GPU memory checkpoints.
- `performance-trace.json` — optional Chromium trace when `DIAG_GPU_TRACE=1`.
- `chat-loaded.png`
- `chat-after-scroll.png`

The generic Spindle harness writes to `out/spindle/` by default.

You can force a specific chat instead of auto-selecting the busiest one:

```bash
export LUMIVERSE_CHAT_ID=<chat ID from URL bar>
```
