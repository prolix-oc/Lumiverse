---
title: Environment Variables (.env)
---

# Environment Variables (.env)

The `.env` file controls how your Lumiverse server starts: its port, data location, networking, runtime behavior, and optional integrations. Most users can keep the setup wizard's defaults. Change only the settings you need.

API connections, presets, and normal account preferences belong in Lumiverse's settings. Launcher options such as `-Build` and `--build` are command-line flags, not `.env` entries; see [Start Script Options](../getting-started/installation.md#start-script-options).

## Find and edit the file

Your `.env` is in the Lumiverse folder, beside `start.ps1`, `start.sh`, and `.env.example`. Open a terminal in that folder:

=== "Windows"

    ```powershell
    .\start.ps1 -EditEnv
    ```

    This uses your configured editor, or Notepad by default.

=== "macOS / Linux / Termux"

    ```bash
    ./start.sh --edit-env
    ```

    On Termux, the editor prefers nano. If needed, install it with `pkg install nano`.

You can also run `bun run edit-env`. If `.env` is missing, the editor offers to create it from `.env.example`.

### How entries work

Use one `NAME=value` entry per line. Lines starting with `#` are comments: remove the `#` to enable an example setting. Edit an existing entry instead of adding a second copy of the same name.

```dotenv
# Change the server port
PORT=8080

# Temporary recovery from broken custom styling
LUMIVERSE_SAFE_THEME=true
```

Save the file and restart Lumiverse. Open `http://localhost:8080` for the example above. Remove `LUMIVERSE_SAFE_THEME` and restart when you want to restore saved styling.

Boolean formats differ by setting. Use the values shown in the tables; `1`, `true`, and `yes` are not interchangeable for every option. Durations ending in `_MS` are milliseconds, and sizes ending in `_BYTES` are bytes.

Keep `.env` private when it contains secrets. Preserve it alongside your data backup when it contains custom paths or encryption settings. See [Termux backup and reinstall](termux-troubleshooting.md#reinstall-while-preserving-your-data) for an example.

## Server and data

| Variable | Default when unset | What it changes |
|----------|--------------------|-----------------|
| `PORT` | `7860` | Server port; integer from `1` to `65535`. |
| `DATA_DIR` | `./data` | Directory containing the database, identity, assets, and other server data. A relative path resolves from the server's working directory. Changing it selects another data location; it does not move your existing files. |
| `FRONTEND_DIR` | Unset in the backend | Path to the built frontend. The start scripts supply it, and the desktop runner can find an existing bundle. Leave it alone for normal launches. |
| `LUMIVERSE_SAFE_THEME` | `false` | Set `true` to suppress saved custom CSS and component overrides without deleting them. Also accepts `1`, `yes`, or `on`. |

## Network and authentication

### Native iOS push

These optional values configure Lumiverse as the provider for Apple's APNs
service. They require an enrolled Apple Developer Program team and a push-capable
iOS app signature. Keep the private key on the server and restart after changes.

| Variable | Default when unset | What it changes |
|----------|--------------------|-----------------|
| `APNS_TEAM_ID` | Unset | The 10-character Apple team ID that owns the app and APNs key. |
| `APNS_KEY_ID` | Unset | The 10-character identifier of the APNs authentication key. |
| `APNS_PRIVATE_KEY_PATH` | Unset | Path to the private `.p8` signing key. All three signing values are required to enable delivery. |
| `APNS_BUNDLE_ID` | `chat.lumiverse.ios` | App bundle identifier authorized by that key. |

### Server access

Prefer **Settings → Operator → Trusted Hostnames** for a specific public address. For a complete HTTPS phone-access example, see [Remote Access with Tailscale](../getting-started/tailscale.md).

| Variable | Default when unset | What it changes |
|----------|--------------------|-----------------|
| `TRUSTED_ORIGINS` | Localhost, `127.0.0.1`, and detected LAN IPv4 origins at `PORT` | Comma-separated allowed origins, such as `http://localhost:7860,https://app.example.com`. Include the scheme and any non-default port. Operator-configured trusted hosts also contribute allowed origins. |
| `TRUST_ANY_ORIGIN` | `false` | Set exactly `true` to enable broad Remote Mode. Allows any origin; use named trusted hosts when you only need a particular address. |
| `TRUSTED_PROXIES` | Empty | Comma-separated proxy IPs or CIDRs allowed to supply forwarded host/protocol headers. For a local HTTP proxy, for example, `127.0.0.1`. Without this list, forwarded host/protocol headers are not trusted; client-IP handling retains its private-peer fallback. |
| `AUTH_BASE_URL` | Approved request origin | Optional fixed origin for authentication/OAuth, such as `https://app.example.com`. Normally use Trusted Hostnames instead. |
| `AUTH_SECRET` | Derived from the identity file | Explicit authentication signing secret. Normally leave unset. |
| `ENCRYPTION_KEY` | Identity-file key | Legacy/manual encryption-key override. Preserve an existing value during migration; do not invent a new one for a working install. |
| `OWNER_USERNAME` | `admin` | Owner display name/fallback; the actual account username is stored in owner credentials. |
| `OWNER_PASSWORD` | Unset | Legacy credential migration or initial Docker provisioning. Normal local setup writes hashed credentials through the wizard. To reset a password, use the launcher or `bun run reset-password`. |

!!! note "Unset does not mean unrestricted"
    Leaving `TRUSTED_ORIGINS` unset uses the local/LAN defaults above. It does not enable `TRUST_ANY_ORIGIN`.

## Direct HTTPS certificates

Leave these unset when Tailscale Serve or another reverse proxy handles HTTPS. See [Direct TLS and custom certificates](../getting-started/installation.md#direct-tls-and-custom-certificates) for certificate examples and Docker mounts.

| Variable | Default | What it changes |
|----------|---------|-----------------|
| `LUMIVERSE_TLS_CERT_FILE` | Unset | PEM certificate/full-chain path. Set together with `LUMIVERSE_TLS_KEY_FILE`; the backend listener becomes HTTPS-only. |
| `LUMIVERSE_TLS_KEY_FILE` | Unset | Matching PEM private-key path. |
| `LUMIVERSE_TLS_KEY_PASSPHRASE_FILE` | Unset | File containing the passphrase for an encrypted private key. |
| `LUMIVERSE_TLS_CONFIG_FILE` | Unset | JSON manifest for certificate selection by hostname/SNI. Use instead of the other three TLS variables; they cannot be combined. |

## Memory and background work

These are optional tuning or troubleshooting settings. Keep defaults unless you have a reason to change them.

| Variable | Default | Values and behavior |
|----------|---------|---------------------|
| `LUMIVERSE_SMOL` | Enabled | Launcher's lower-memory Bun mode. Set `false`, `0`, `off`, or `no` to disable; other values keep it enabled. Applies to server launches through the start scripts or runner. |
| `LUMIVERSE_PROMPT_ASSEMBLY_WORKER` | Enabled when compatible | Set exactly `false` to assemble prompts in the main process. Incompatible extension hooks can also cause an automatic fallback. |
| `LUMIVERSE_PROMPT_ASSEMBLY_WORKERS` | Requests `2` | Positive worker count, capped by available CPU parallelism. |
| `LUMIVERSE_PROMPT_ASSEMBLY_IDLE_MS` | `600000` (10 minutes) | Worker idle timeout, clamped to `30000`–`1800000` (30 seconds–30 minutes). |
| `LUMIVERSE_CORTEX_WORKER` | Enabled | Set exactly `false` to disable the Memory Cortex warm worker. |
| `LUMIVERSE_CHAT_VECTORIZATION_SUBPROCESS` | Disabled on Windows; enabled elsewhere when available | Set `true` to opt in on Windows or `false` to disable. Failures can fall back to in-process execution. |
| `LUMIVERSE_LANCEDB_STARTUP_MAINTENANCE` | Enabled | Deferred LanceDB maintenance after startup. Set `false`, `0`, `no`, or `off` to disable; maintenance can then be run from Operator. |
| `LUMIVERSE_SQLITE_MMAP_ENABLED` | `false` | Set exactly `true` to opt into SQLite memory-mapped I/O. Normally leave disabled: filesystem or disk-space failures can crash the process. |
| `LUMIVERSE_SQLITE_MMAP_DISABLED` | Unset | Legacy kill switch: exactly `true` overrides the mmap opt-in. |
| `LUMIVERSE_INLINE_TOOL_MAX_ROUNDS` | `3` | Maximum inline tool rounds per generation; a number of at least `1`, rounded down. |

## Disk health

See [Disk Health & SMART](../settings/disk-health.md) for monitoring setup. Disk-pressure warnings require **both** thresholds to be crossed. The environment supplies startup defaults until the owner saves overrides in Operator.

| Variable | Default | Values and behavior |
|----------|---------|---------------------|
| `LUMIVERSE_DISK_WARNING_USAGE_PERCENT` | `90` percent | Usage threshold. Accepts a ratio greater than `0` through `1`, or a percentage greater than `1` through `100`. |
| `LUMIVERSE_DISK_WARNING_MIN_FREE_BYTES` | `107374182400` (100 GiB) | Free-space threshold; positive byte count. |
| `LUMIVERSE_SMARTCTL_PATH` | Auto-detected | Explicit path to the `smartctl` executable. |
| `LUMIVERSE_SMART_MONITOR` | Enabled | Set exactly `false` to disable scheduled SMART checks. Requires available tooling and access to the device. |
| `LUMIVERSE_SMARTCTL_AUTO_INSTALL` | Disabled | Set exactly `true` for unattended startup installation through a supported package manager. Does not invoke sudo or ask for credentials. |

## Extension storage

These settings govern Spindle's ephemeral storage pools. They are byte limits, not counts of extensions.

| Variable | Default | Values and behavior |
|----------|---------|---------------------|
| `SPINDLE_EPHEMERAL_GLOBAL_MAX_BYTES` | `524288000` (500 MiB) | Total ephemeral storage limit; positive integer. |
| `SPINDLE_EPHEMERAL_EXTENSION_DEFAULT_MAX_BYTES` | `52428800` (50 MiB) | Default per-extension limit; positive integer. |
| `SPINDLE_EPHEMERAL_EXTENSION_MAX_OVERRIDES` | Empty | Comma-separated overrides in `extension.id:bytes` format. |
| `SPINDLE_EPHEMERAL_RESERVATION_TTL_MS` | `600000` (10 minutes) | Storage reservation lifetime; positive integer in milliseconds. |

```dotenv
SPINDLE_EPHEMERAL_EXTENSION_MAX_OVERRIDES=example.extension:104857600
```

Replace `example.extension` with the installed extension's actual identifier.

## Vector database overrides

Normally configure this through Operator. Setting `LUMIVERSE_VECTOR_STORE_PROVIDER` overrides the stored provider and connection and makes those fields read-only in the Operator UI. Saved runtime tuning remains effective. Provider credentials here are secrets.

| Variable | Default | What it changes |
|----------|---------|-----------------|
| `LUMIVERSE_VECTOR_STORE_PROVIDER` | Stored configuration | Select `lancedb`, `qdrant`, or `milvus`. Leave unset to use the UI configuration. |
| `LUMIVERSE_QDRANT_URL` | Empty | Qdrant server URL when using that provider. |
| `LUMIVERSE_QDRANT_API_KEY` | Empty | Optional Qdrant authentication key. |
| `LUMIVERSE_MILVUS_ADDRESS` | Empty | Milvus server address. |
| `LUMIVERSE_MILVUS_DATABASE` | Server default | Milvus database shared by runtime and maintenance tools. |
| `LUMIVERSE_MILVUS_USERNAME` | Empty | Milvus username. |
| `LUMIVERSE_MILVUS_PASSWORD` | Empty | Milvus password. |
| `LUMIVERSE_MILVUS_SSL` | `false` | Set exactly `true` for a TLS connection to Milvus. |
| `LUMIVERSE_MILVUS_CONNECT_TIMEOUT_MS` | Provider default | Positive connection timeout in milliseconds. |
| `LUMIVERSE_MILVUS_REQUEST_TIMEOUT_MS` | Provider default | Non-negative request timeout in milliseconds; `0` is accepted. |
| `LUMIVERSE_MILVUS_FLUSH_POLICY` | `per_write` | Set `manual` to flush during explicit maintenance, using Strong reads for visibility. A policy saved in Operator takes precedence. Validate with the [Milvus maintenance tools](../settings/milvus-maintenance.md) before enabling. |

## Migration and remote files

Use [Settings → Migration](../getting-started/installation.md#migrating-from-sillytavern) for an interactive import. The startup migration variables below are intended for Docker's one-time import flow.

| Variable | Default | What it changes |
|----------|---------|-----------------|
| `LUMIVERSE_ST_MIGRATE` | `false` | Set exactly `true` to enable startup SillyTavern migration. |
| `SILLYTAVERN_PATH` | `./data/SillyTavern` | Source data path visible to the server/container. |
| `SILLYTAVERN_TARGET_USER` | `default-user` | SillyTavern user directory to import. |
| `SILLYTAVERN_MIGRATION_TARGET` | `5` | Import scope: `1` characters, `2` world books, `3` personas, `4` characters and chats, `5` everything. Clamped to `1`–`5`. |
| `LUMIVERSE_FORCE_NEW_MIGRATION` | `false` | Exactly `true` re-runs startup migration even after a completed import. |
| `LUMIVERSE_ENABLE_SFTP` | Disabled | `1` or `true` enables probing the optional SFTP source. Only enable on a runtime that can load its native dependency; unsupported Bun builds can crash on import. Local and other migration sources do not require it. |
| `LUMIVERSE_ST_MIGRATION_SUBPROCESS` | Enabled | Exactly `false` disables migration subprocess execution for troubleshooting. |
| `LUMIVERSE_REMOTE_FILE_MAX_BYTES` | `104857600` (100 MiB) | Positive remote-file size cap for guarded fetches. |
| `LUMIVERSE_REMOTE_FETCH_TIMEOUT_MS` | `30000` (30 seconds) | Positive per-request timeout for remote HTTP file providers. |

## Other optional integrations

| Variable | Default | What it changes |
|----------|---------|-----------------|
| `POLLINATIONS_APP_KEY` | Built-in publishable app key | Per-instance Pollinations BYOP publishable app-key override. |

This reference covers operator configuration rather than variables supplied internally by launchers, child processes, tests, or developer diagnostics. The checked-in `.env.example` is a starter template; a supported setting does not have to appear in that template to work.
