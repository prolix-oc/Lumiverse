# Lumiverse browser diagnostics

Uses Playwright to open a live Lumiverse instance, log in, and run targeted diagnostics against chat pages and Spindle extensions.

## Setup

```bash
cd scripts/e2e-diagnostics
bun install
# or: npm install
```

## Run

Create a `.env` file (see `.env.example`) or export the variables:

```bash
export LUMIVERSE_URL=https://my.lumiverse.app
export LUMIVERSE_USER=admin
export LUMIVERSE_PASS="your-password"

bun run diagnose
```

## Scripts

- `node check-spindle-touch-scroll.mjs`
  Audits the real installed-iOS document guard and Spindle widget policy with synthetic touch events in Chromium, Firefox and WebKit, at desktop and notched-iPhone viewport sizes. Checks default guarding, opt-in, isolation from core and nested widgets, shadow content, reversal and root teardown. No server, credentials or user data. `PLAYWRIGHT_MODULE` can point to an existing Playwright installation. This tests cancellation decisions, not physical installed-PWA scrolling.

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
- `bun run diagnose`
  Captures general chat scroll and virtualization stats on the busiest recent chat.
- `bun run diagnose:spindle`
  Runs a generic Spindle extension sweep against a chat page or custom target route and captures extension logs, websocket traffic, root snapshots, screenshots, and optional button probes.

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

## Output

Results are written to `out/`:

- `report.json` — message-list stats, long-task count, layout-event count, scroll-event count, rAF count, and Chrome Performance metrics before/after the scroll gesture.
- `chat-loaded.png`
- `chat-after-scroll.png`

The generic Spindle harness writes to `out/spindle/` by default.

You can force a specific chat instead of auto-selecting the busiest one:

```bash
export LUMIVERSE_CHAT_ID=<chat ID from URL bar>
```
