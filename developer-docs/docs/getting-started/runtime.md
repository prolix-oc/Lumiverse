# Runtime Modes

Spindle backend extensions no longer assume a single execution model.

Lumiverse can run a backend extension in one of three runtime modes:

- `process` — separate Bun subprocess per extension. This is the default.
- `sandbox` — Bun subprocess wrapped in a platform sandbox when available.
- `worker` — legacy Bun worker-thread execution inside the main server process.

The backend and frontend extension APIs do **not** change across these modes. Existing extensions should keep using the same `spindle` API and the same frontend `ctx` APIs.

## Default Behavior

If `LUMIVERSE_SPINDLE_RUNTIME_MODE` is not set, Lumiverse defaults to:

```bash
LUMIVERSE_SPINDLE_RUNTIME_MODE=process
```

This gives each backend extension its own process boundary without requiring extra configuration.

## Runtime Mode Env Vars

| Variable | Default | Description |
|---|---|---|
| `LUMIVERSE_SPINDLE_RUNTIME_MODE` | `process` | Runtime mode for backend extensions: `process`, `sandbox`, or `worker` |
| `LUMIVERSE_SPINDLE_RUNTIME_STATS` | disabled | Enable runtime startup/RSS instrumentation when set to `true`, `1`, or `yes` |
| `LUMIVERSE_SPINDLE_RUNTIME_SAMPLE_INTERVAL_MS` | `30000` when stats are enabled | RSS sampling interval for subprocess runtimes. Set to `0` to disable periodic sampling |

## Platform Behavior

### macOS

- `process` runs each extension in its own Bun subprocess.
- `sandbox` wraps that subprocess with `sandbox-exec` (Seatbelt).
- `worker` uses the old Bun worker-thread model.

### Linux

- `process` runs each extension in its own Bun subprocess.
- `sandbox` currently falls back to `process` because there is no Linux sandbox wrapper in place yet.
- `worker` uses the old Bun worker-thread model.

### Windows

- `process` runs each extension in its own Bun subprocess.
- `sandbox` currently falls back to `process`.
- `worker` uses the old Bun worker-thread model.

### Termux / Android

Subprocess runtimes reuse Lumiverse's existing Termux-aware Bun command wrapper. This means the same `LUMIVERSE_BUN_PATH`, `LUMIVERSE_BUN_METHOD`, `proot`, `grun`, and glibc linker handling used during extension install/build is also used when starting backend extension runtimes.

## Sandbox Notes

`sandbox` is currently strongest on macOS.

- macOS: real Seatbelt sandboxing via `sandbox-exec`
- Linux: falls back to `process`
- Windows: falls back to `process`

If you need predictable cross-platform behavior today, treat `sandbox` as:

- a macOS hardening mode
- a no-op alias for `process` elsewhere

## Runtime Stats

Runtime stats are **off by default** so normal users and operators do not get extra WS events or log noise.

To enable them:

```bash
LUMIVERSE_SPINDLE_RUNTIME_STATS=true
```

When enabled, Lumiverse emits `SPINDLE_RUNTIME_STATS` events and backend log lines for:

- startup timing
- subprocess RSS samples
- shutdown samples

This is intended for benchmarking and rollout validation, not normal production operation.

## Frontend Startup Expectations

Frontend extension loading is intentionally decoupled from backend runtime start.

- enabling an extension updates extension state immediately
- frontend bundle loading may complete slightly later
- extension list refreshes do not block on all frontend modules finishing setup

That improves perceived startup performance, but it means frontend-capable extensions should not assume their UI is fully mounted the instant the backend runtime becomes ready.

## Developer Guidance

### Recommended Mode By Trust Level

- trusted local / first-party extensions: `process` or `worker`
- third-party or less-trusted extensions: `sandbox` on macOS, otherwise `process`

### What Should Not Change In Your Extension

You should **not** need to change:

- backend `spindle.*` API usage
- frontend `ctx.*` API usage
- frontend/backend messaging patterns
- permission handling patterns

Runtime mode is an execution detail owned by Lumiverse, not by extension authors.
