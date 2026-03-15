# Ephemeral Storage

!!! warning "Permission required: `ephemeral_storage`"

Temporary storage with TTL (time-to-live), automatic expiration, and per-extension memory pooling. Use this for caches, intermediate computation results, or any data that doesn't need to survive restarts.

Ephemeral storage lives in memory and on disk under `{DATA_DIR}/ephemeral/{identifier}/`. Unlike regular storage, files can auto-expire and are subject to quota limits.

## Basic Usage

```ts
// Write with a 5-minute TTL
await spindle.ephemeral.write('cache/scene.json', JSON.stringify(scene), {
  ttlMs: 5 * 60 * 1000,
})

// Read (throws if expired or missing)
const data = await spindle.ephemeral.read('cache/scene.json')

// Binary I/O
await spindle.ephemeral.writeBinary('cache/image.webp', imageBytes, { ttlMs: 600_000 })
const bytes = await spindle.ephemeral.readBinary('cache/image.webp')

// List and delete
const files = await spindle.ephemeral.list('cache/')
await spindle.ephemeral.delete('cache/scene.json')

// File metadata (includes expiration)
const info = await spindle.ephemeral.stat('cache/scene.json')
// { sizeBytes: 1234, createdAt: "2024-...", expiresAt: "2024-..." }

// Housekeeping: remove all expired files
const removedCount = await spindle.ephemeral.clearExpired()
```

## Methods

| Method | Returns | Description |
|---|---|---|
| `read(path)` | `Promise<string>` | Read a text file |
| `write(path, data, options?)` | `Promise<void>` | Write a text file. Options: `{ ttlMs?, reservationId? }` |
| `readBinary(path)` | `Promise<Uint8Array>` | Read raw bytes |
| `writeBinary(path, data, options?)` | `Promise<void>` | Write raw bytes. Options: `{ ttlMs?, reservationId? }` |
| `delete(path)` | `Promise<void>` | Delete a file |
| `list(prefix?)` | `Promise<string[]>` | List files, optionally under a prefix |
| `stat(path)` | `Promise<EphemeralStatResult>` | Get file metadata including expiration |
| `clearExpired()` | `Promise<number>` | Remove all expired files, returns count removed |
| `getPoolStatus()` | `Promise<PoolStatus>` | Get quota usage for your extension and the global pool |
| `requestBlock(sizeBytes, options?)` | `Promise<Reservation>` | Reserve a quota block before writing large data. Options: `{ ttlMs?, reason? }` |
| `releaseBlock(reservationId)` | `Promise<void>` | Release a previously reserved quota block |

## Quota System

Each extension has a quota (default 50 MB, configurable by the server admin). The global pool across all extensions is capped too (default 500 MB). Files are also capped at 250 per extension.

For large writes, **reserve a quota block first** to avoid hitting the limit mid-operation:

```ts
// Reserve 10 MB for a batch operation
const reservation = await spindle.ephemeral.requestBlock(10 * 1024 * 1024, {
  ttlMs: 60_000,  // reservation expires in 1 minute if unused
  reason: 'batch image cache',
})

// Write using the reservation
await spindle.ephemeral.writeBinary('cache/big-file.bin', data, {
  reservationId: reservation.reservationId,
})

// Release the reservation when done (unused space is freed)
await spindle.ephemeral.releaseBlock(reservation.reservationId)
```

## Pool Status

```ts
const status = await spindle.ephemeral.getPoolStatus()
// {
//   globalMaxBytes, globalUsedBytes, globalReservedBytes, globalAvailableBytes,
//   extensionMaxBytes, extensionUsedBytes, extensionReservedBytes, extensionAvailableBytes,
//   fileCount, fileCountMax
// }
```
