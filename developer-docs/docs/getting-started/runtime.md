# Runtime Modes

Spindle backend extensions no longer assume a single execution model.

Lumiverse can run a backend extension in one of three runtime modes:

- `process` — separate Bun subprocess per extension. This is the default.
- `sandbox` — Bun subprocess wrapped in a platform sandbox when available.
- `worker` — legacy Bun worker-thread execution inside the main server process.

The backend and frontend extension APIs do **not** change across these modes. Existing extensions should keep using the same `spindle` API and the same frontend `ctx` APIs.

That includes the process lifecycle surfaces: `spindle.frontendProcesses` on the backend and `ctx.processes.register(...)` on the frontend behave the same across `process`, `sandbox`, and `worker` runtime modes, and `spindle.backendProcesses` always spawns an isolated subprocess boundary for child backend work.

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

## Frontend startup and readiness

Frontend bundle loading remains decoupled from backend runtime start, so an extension's UI may finish loading later. The loader awaits any `setup(ctx)` promise before completing the frontend load; startup-message delivery is separately controlled by `ctx.ready()` and `ctx.deferReady()`. With manual readiness, `ready()` may flush queued messages before an asynchronous setup promise settles once handlers are safe; the load operation still awaits that promise.

- `setup(ctx)` may return a cleanup function directly or return a `Promise` for `void` or a cleanup function. The loader awaits that promise before completing setup.
- A setup that does not call `ctx.deferReady()` is auto-readied only after setup has settled successfully. This preserves legacy synchronous setup behavior; a synchronous throw or asynchronous rejection instead fails the load and runs teardown/cleanup.
- Call `ctx.deferReady()` during setup when startup messages must remain queued. The extension must later call the idempotent `ctx.ready()` explicitly after its handlers and initial UI are safe to receive those messages.
- The host uses a bounded 10-second readiness deadline. If `ctx.ready()` is not called in time, the readiness promise rejects and the frontend is unloaded; the queue is discarded rather than auto-flushed or auto-recovered.

Frontend-capable extensions should not assume their UI is mounted the instant the backend runtime becomes ready. If setup or readiness fails, the extension remains unloaded and does not receive startup traffic.

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

## Per-Task Isolation

Runtime mode controls how the main backend extension runtime starts.

If one part of your extension needs a stronger kill boundary than the rest, use [`spindle.backendProcesses`](../backend-api/backend-processes.md) to move just that slice into a host-supervised child subprocess.

That is especially useful when a loop could block its own event loop. In that case, the host can still fire watchdog timers and terminate the child even though the child can no longer cooperate.
