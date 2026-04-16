# Version

Read the semantic versions of the running Lumiverse backend server and shipped frontend bundle. Useful for feature gating, compatibility checks, diagnostics, and telemetry.

No permission is required. This is a free-tier API.

## Usage

```ts
const backend = await spindle.version.getBackend()
const frontend = await spindle.version.getFrontend()

spindle.log.info(`Running against Lumiverse backend ${backend} / frontend ${frontend}`)
```

## Methods

### `spindle.version.getBackend()`

Returns the `version` field from the backend server's `package.json`.

**Returns:** `Promise<string>` — a semantic version string (e.g. `"0.8.8"`).

### `spindle.version.getFrontend()`

Returns the `version` field from the frontend bundle's `package.json`.

**Returns:** `Promise<string>` — a semantic version string (e.g. `"0.8.8"`).

## How It Works

The host reads each version from its `package.json` on the first call and caches the result for the lifetime of the process. Subsequent calls are effectively free — no disk I/O, no JSON parsing.

The backend and frontend are versioned independently. During normal releases they track the same number, but a staging backend may temporarily run ahead of the deployed frontend (or vice versa). Always compare both if you need to know whether a given capability is available end-to-end.

## Example: Feature Gate Against a Minimum Version

```ts
function gte(version: string, minimum: string): boolean {
  const a = version.split('.').map(Number)
  const b = minimum.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false
  }
  return true
}

const backend = await spindle.version.getBackend()

if (gte(backend, '0.8.8')) {
  registerModernFeature()
} else {
  spindle.log.warn(`Backend ${backend} is below the 0.8.8 minimum — skipping feature`)
}
```

## Example: Attach Versions to Telemetry

```ts
const [backend, frontend] = await Promise.all([
  spindle.version.getBackend(),
  spindle.version.getFrontend(),
])

await spindle.events.track('extension_started', {
  backendVersion: backend,
  frontendVersion: frontend,
})
```

!!! note
    The returned strings are whatever is in the corresponding `package.json` — don't assume any particular format beyond the `MAJOR.MINOR.PATCH` convention Lumiverse follows today. Parse defensively if you need numeric comparisons.
