# Manifest (`spindle.json`)

Every extension needs a `spindle.json` at the repository root.

```json
{
  "version": "1.0.0",
  "name": "My Extension",
  "identifier": "my_extension",
  "author": "Your Name",
  "github": "https://github.com/you/my-extension",
  "homepage": "https://example.com",
  "description": "A brief description of what this extension does.",
  "permissions": ["generation", "interceptor"],
  "entry_backend": "dist/backend.js",
  "entry_frontend": "dist/frontend.js",
  "minimum_lumiverse_version": "0.1.0"
}
```

## Fields

| Field | Required | Description |
|---|---|---|
| `version` | Yes | Semver version string |
| `name` | Yes | Human-readable display name |
| `identifier` | Yes | Unique ID. Lowercase letters, numbers, and underscores only. Must start with a letter. Pattern: `/^[a-z][a-z0-9_]*$/` |
| `author` | Yes | Author name |
| `github` | Yes | GitHub repository URL |
| `homepage` | Yes | Extension homepage or docs URL |
| `description` | No | Short description shown in the Extensions panel |
| `permissions` | Yes | Array of gated permissions this extension requires (can be `[]`) |
| `entry_backend` | No | Path to backend entry. Default: `"dist/backend.js"` |
| `entry_frontend` | No | Path to frontend entry. Default: `"dist/frontend.js"` |
| `minimum_lumiverse_version` | No | Minimum Lumiverse version required |
| `storage_seed_files` | No | Files/directories to copy into extension storage on install (see below) |
| `interceptorTimeoutMs` | No | Per-extension override (in milliseconds) for how long the host will wait for this extension's interceptor to return. See [Interceptor Timeout](#interceptor-timeout) below |

## Storage Seed Files

Seed files let you ship default data (config templates, databases, assets) that get copied into the extension's storage directory on install.

```json
{
  "storage_seed_files": [
    { "from": "defaults/config.json", "to": "config.json" },
    { "from": "assets/", "to": "assets/", "overwrite": false },
    { "from": "required-data.db", "required": true }
  ]
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `from` | `string` | *required* | Source path relative to the extension repo root |
| `to` | `string` | same as `from` | Destination path relative to extension storage root |
| `overwrite` | `boolean` | `false` | If `true`, overwrite existing files on update |
| `required` | `boolean` | `false` | If `true`, fail installation when the source file is missing |

## Interceptor Timeout

Extensions that register a pre-generation interceptor are bound by a wall-clock budget. The host resolves this budget **per run**, so both the manifest value and the user's Spindle setting take effect on the next generation without requiring the extension to re-register.

Resolution order (highest priority first):

1. `interceptorTimeoutMs` in your manifest
2. The user's `spindleSettings.interceptorTimeoutMs` setting (configurable in the Spindle panel)
3. Default: `10000` ms

All values are clamped to `[1000, 300000]` ms (1 second to 5 minutes).

```json
{
  "identifier": "my_retrieval_extension",
  "permissions": ["interceptor"],
  "interceptorTimeoutMs": 45000
}
```

Use this when your interceptor performs real work before the LLM call — multi-step retrieval, graph traversal, external API lookups, or controller-driven context assembly — and needs a larger budget than the 10 second default. See [Interceptors → Timeout](../backend-api/interceptors.md#timeout) for the full behavior, including what happens when the budget is exceeded.
