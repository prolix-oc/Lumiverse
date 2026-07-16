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
| `permissions` | Yes | Array of permission names this extension requests (can be `[]`); non-privileged permissions are granted automatically and privileged permissions require approval |
| `requested_capabilities` | No | Array of declared backend capabilities. These suppress specific scanner blocks; `dynamic_code_execution` also enables guarded constructors in backend runtimes and backend-process children. See [Backend Capabilities](capabilities.md) |
| `entry_backend` | No | Path to backend entry. Default: `"dist/backend.js"` |
| `entry_frontend` | No | Path to frontend entry. Default: `"dist/frontend.js"` |
| `minimum_lumiverse_version` | No | Minimum Lumiverse version required |
| `storage_seed_files` | No | Files/directories to copy into extension storage on install (see below) |
| `interceptorTimeoutMs` | No | Per-extension override (in milliseconds) for how long the host will wait for this extension's interceptor to return. See [Interceptor Timeout](#interceptor-timeout) below |

## Requested Capabilities

`requested_capabilities` is distinct from `permissions`. Permissions gate runtime API surfaces (`spindle.generate`, `spindle.chats`, etc.). Capabilities suppress declared **scanner blocks** for code patterns the extension legitimately needs. `dynamic_code_execution` additionally enables guarded `eval` and Function-family constructors in backend runtimes and extension-owned backend-process children; it does not enable frontend evaluation, module loading, or any host API.

```json
{
  "requested_capabilities": ["dynamic_code_execution", "base64_decode"]
}
```

Available capabilities:

| Capability | Suppresses |
|---|---|
| `"dynamic_code_execution"` | The `dynamic code execution` scanner block, plus guarded `eval` and Function-family constructors in backend runtimes and backend-process children. Required when the bundled backend contains `eval(` or `Function(` / `new Function(` — including inside vendored libraries (Zod feature-detect probes), inside `RegExp` literals whose source mentions `Function\s*\(`, or as part of a sandboxed in-extension script runner |
| `"base64_decode"` | The `base64 decoding` block. Required when the bundled backend uses `Buffer.from(value, "base64")` — common for binary asset I/O and image helpers |

Only declare capabilities you actually need. A full description of each, plus the list of patterns that **cannot** be opted out of, is in [Backend Capabilities](capabilities.md).

The declaration is evaluated while installing or updating the extension and when a backend runtime starts. A running extension keeps the loaded manifest until it is reloaded/restarted, so changing `requested_capabilities` is not a hot update. Unresolved or dynamic **bare** `import(specifier)` / `require(specifier)` expressions visible in scanned backend source fail closed rather than being treated as safe. The separate privileged `unsafe_eval` permission only enables `allowEval: true` for host-managed frontend sandbox frames created with `ctx.dom.createSandboxFrame`; it does not enable general frontend or backend evaluation.

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
