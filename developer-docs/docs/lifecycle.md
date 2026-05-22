# Lifecycle

## Installation

1. User provides a GitHub URL
2. Lumiverse clones the repo to `{DATA_DIR}/extensions/{identifier}/repo/`
3. Reads and validates `spindle.json`
4. If no `dist/` folder exists, runs `bun build` on `src/backend.ts` and `src/frontend.ts`
5. Extension is registered in the database
6. Backend runtime is started if the extension is enabled

## Enable / Disable

- **Enable:** starts the backend runtime and schedules the frontend module to load
- **Disable:** sends `shutdown` to the backend runtime (5s grace period), tears down the frontend module, unregisters all macros/interceptors/tools/context handlers, and stops any active frontend processes owned by the extension

By default, backend runtimes start in `process` mode. See [Runtime Modes](getting-started/runtime.md) for platform-specific behavior.

## Update

1. Runs `git pull` in the extension's repo directory
2. Re-reads `spindle.json`
3. Rebuilds from source if needed
4. Restarts the backend runtime if the extension was running

## Removal

1. Stops the backend runtime
2. Deletes the database row (cascades permission grants)
3. Deletes the extension directory (repo + storage)

## Startup Order

On Lumiverse boot, all enabled extensions are started after database migrations complete. Extensions should not depend on a specific load order.
