# Portrait Dock settings hydration race

## Root cause
Before the authoritative settings GET completed, Portrait Dock geometry/state synchronization could call `setSetting` with an automatic mutation that defaulted to user provenance. That incremented the local revision and caused the server row to appear stale, so saved values such as `dockSide`, `defaultDockSide`, and `rememberSizePosition` were skipped during merge. Defaults could then be persisted back. Suite compatibility repair could contribute by writing a normalized fallback before the host was hydrated.

## Guardrails
- Automatic synchronization does not create revision precedence before `fullSettingsLoaded`.
- Explicit UI interaction remains authoritative, including interaction during an in-flight GET.
- Compatibility repair waits for host readiness.
- Keep canonical settings authoritative over compatibility copies.

## Debugging checklist
1. Compare `localSettingsRevision` at load start with the affected key revision.
2. Record the exact source and event boundary of every pre-hydration write.
3. Inspect incoming, server, local, and skipped key summaries for the full setting object, not only `dockSide`.
4. Check for geometry feedback loops or repeated viewport normalization.
5. Validate left/false and right/true settings, genuine interaction during GET, repeated reloads, rendered Productivity controls, Suite lifecycle behavior, typecheck, lint, and production builds.
