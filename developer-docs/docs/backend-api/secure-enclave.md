# Secure Enclave

Encrypted at-rest secret storage for API keys, OAuth tokens, and other sensitive credentials. Secrets are encrypted with AES-256-GCM and stored per-user in the Lumiverse secrets database — they are never written to disk as plaintext.

No permission is required (free tier).

For **user-scoped** extensions, the `userId` is inferred automatically. For **operator-scoped** extensions, you must pass `userId` explicitly.

## Usage

```ts
// Store a secret
await spindle.enclave.put('spotify_token', accessToken, userId)

// Retrieve a secret
const token = await spindle.enclave.get('spotify_token', userId)
if (token) {
  // use the token
}

// Check if a secret exists (without retrieving it)
const hasToken = await spindle.enclave.has('spotify_token', userId)

// List all secret keys for this extension
const keys = await spindle.enclave.list(userId)
// -> ['spotify_token', 'refresh_token', 'client_secret']

// Delete a secret
await spindle.enclave.delete('spotify_token', userId)
```

## Methods

| Method | Returns | Description |
|---|---|---|
| `put(key, value, userId?)` | `Promise<void>` | Store or update an encrypted secret |
| `get(key, userId?)` | `Promise<string \| null>` | Retrieve a decrypted secret, or `null` if not found |
| `delete(key, userId?)` | `Promise<boolean>` | Delete a secret. Returns `true` if it existed |
| `has(key, userId?)` | `Promise<boolean>` | Check if a secret exists (without decrypting) |
| `list(userId?)` | `Promise<string[]>` | List all secret keys for this extension and user |

## Key Constraints

- **Pattern:** `^[a-zA-Z0-9_\-.]{1,128}$` — alphanumeric, underscore, dash, and dot only
- **Max length:** 128 characters

## Value Constraints

- Must be a string
- **Max size:** 64 KB
- **Allowed characters:** printable ASCII (`0x20`-`0x7E`) plus `\t`, `\n`, `\r` — no binary or control characters

## Namespacing

Keys are automatically namespaced as `spindle:{identifier}:{key}` in the underlying secrets table. Extensions cannot read each other's secrets. The `list()` method only returns the bare key names (without the namespace prefix).

## When to Use Enclave vs. Storage

| Use case | Use |
|---|---|
| OAuth tokens, API keys, client secrets | `spindle.enclave` |
| User preferences, UI state, cached data | `spindle.userStorage` or `spindle.storage` |
| Shared config for all users (operator-scoped) | `spindle.storage` |
| Per-user config (operator-scoped) | `spindle.userStorage` |
