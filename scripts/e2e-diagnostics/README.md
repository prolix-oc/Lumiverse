# Lumiverse browser diagnostics

Uses Playwright to open a live Lumiverse instance, log in, enter the busiest recent chat, and measure scroll/virtualization behavior.

## Setup

```bash
cd scripts/e2e-diagnostics
bun install
# or: npm install
```

## Run

Create a `.env` file (see `.env.example`) or export the variables:

```bash
export LUMIVERSE_URL=https://app.lumiverse.chat
export LUMIVERSE_USER=prolix
export LUMIVERSE_PASS="your-password"

bun run diagnose
```

## Output

Results are written to `out/`:

- `report.json` — message-list stats, long-task count, layout-event count, scroll-event count, rAF count, and Chrome Performance metrics before/after the scroll gesture.
- `chat-loaded.png`
- `chat-after-scroll.png`

You can force a specific chat instead of auto-selecting the busiest one:

```bash
export LUMIVERSE_CHAT_ID=0c87c160-24e4-439d-a588-3008a7fd6b93
```
