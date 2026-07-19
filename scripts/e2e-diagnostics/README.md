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
