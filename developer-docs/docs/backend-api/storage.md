# Storage

Each extension gets a private, scoped storage directory. All paths are relative to your extension's storage root. Path traversal is blocked.

## Basic Operations

```ts
// Write
await spindle.storage.write('config.json', JSON.stringify({ theme: 'dark' }))

// Read
const data = await spindle.storage.read('config.json')
const config = JSON.parse(data)

// List files
const files = await spindle.storage.list()          // all files
const logs = await spindle.storage.list('logs/')     // files under logs/

// Delete
await spindle.storage.delete('config.json')
```

## Advanced Operations

```ts
// Binary I/O
const imgBytes = await spindle.storage.readBinary('images/logo.png')
await spindle.storage.writeBinary('images/logo.png', new Uint8Array([...]))

// File system operations
const exists = await spindle.storage.exists('config.json')
await spindle.storage.mkdir('logs/2024')
await spindle.storage.move('old.json', 'archive/old.json')

// File metadata
const info = await spindle.storage.stat('config.json')
// { exists: true, isFile: true, isDirectory: false, sizeBytes: 1234, modifiedAt: "2024-01-01T..." }

// JSON convenience (handles parse/serialize + fallback)
const config = await spindle.storage.getJson('config.json', { fallback: { theme: 'dark' } })
await spindle.storage.setJson('config.json', { theme: 'light' }, { indent: 2 })
```

## Methods

| Method | Returns | Description |
|---|---|---|
| `read(path)` | `Promise<string>` | Read a file as UTF-8 text |
| `write(path, data)` | `Promise<void>` | Write a UTF-8 text file (creates directories as needed) |
| `readBinary(path)` | `Promise<Uint8Array>` | Read a file as raw bytes |
| `writeBinary(path, data)` | `Promise<void>` | Write raw bytes to a file |
| `delete(path)` | `Promise<void>` | Delete a file |
| `list(prefix?)` | `Promise<string[]>` | List files, optionally under a prefix/directory |
| `exists(path)` | `Promise<boolean>` | Check if a file or directory exists |
| `mkdir(path)` | `Promise<void>` | Create a directory (recursive) |
| `move(from, to)` | `Promise<void>` | Move or rename a file |
| `stat(path)` | `Promise<StatResult>` | Get file metadata (see below) |
| `getJson<T>(path, options?)` | `Promise<T>` | Read and parse a JSON file. Options: `{ fallback?: T }` |
| `setJson(path, value, options?)` | `Promise<void>` | Serialize and write a JSON file. Options: `{ indent?: number }` |

## StatResult

```ts
{
  exists: boolean
  isFile: boolean
  isDirectory: boolean
  sizeBytes: number
  modifiedAt: string  // ISO 8601
}
```

**Storage location:** `{DATA_DIR}/extensions/{identifier}/storage/`

Path traversal is blocked — paths like `../../etc/passwd` will throw.

---

## User Storage

Per-user isolated storage that keeps each user's data separate — even when the extension is installed globally (`install_scope: "operator"`). Regular `spindle.storage` routes to a single shared directory for operator-scoped extensions; `spindle.userStorage` always routes to `{DATA_DIR}/users/{userId}/extensions/{identifier}/`.

For **user-scoped** extensions, the `userId` is inferred automatically from the extension owner. For **operator-scoped** extensions, you must pass `userId` explicitly.

```ts
// Write per-user config
await spindle.userStorage.setJson('config.json', { theme: 'dark' }, { userId })

// Read per-user config
const config = await spindle.userStorage.getJson('config.json', {
  fallback: { theme: 'light' },
  userId,
})

// Write raw text
await spindle.userStorage.write('notes.txt', 'Hello world', userId)

// Read raw text
const text = await spindle.userStorage.read('notes.txt', userId)

// Write raw bytes (per user)
await spindle.userStorage.writeBinary('avatar.png', pngBytes, userId)

// Read raw bytes (per user)
const bytes = await spindle.userStorage.readBinary('avatar.png', userId)

// List files
const files = await spindle.userStorage.list(undefined, userId)

// Check existence
const exists = await spindle.userStorage.exists('config.json', userId)

// Create directory
await spindle.userStorage.mkdir('cache/', userId)

// Move / rename within the user's scope
await spindle.userStorage.move('notes.txt', 'archive/notes.txt', userId)

// Metadata
const meta = await spindle.userStorage.stat('archive/notes.txt', userId)

// Delete
await spindle.userStorage.delete('notes.txt', userId)
```

### User Storage Methods

| Method | Returns | Description |
|---|---|---|
| `read(path, userId?)` | `Promise<string>` | Read a file as UTF-8 text |
| `write(path, data, userId?)` | `Promise<void>` | Write a UTF-8 text file (creates directories as needed) |
| `readBinary(path, userId?)` | `Promise<Uint8Array>` | Read a file as raw bytes |
| `writeBinary(path, data, userId?)` | `Promise<void>` | Write raw bytes to a file |
| `delete(path, userId?)` | `Promise<void>` | Delete a file |
| `list(prefix?, userId?)` | `Promise<string[]>` | List files, optionally under a prefix/directory |
| `exists(path, userId?)` | `Promise<boolean>` | Check if a file or directory exists |
| `mkdir(path, userId?)` | `Promise<void>` | Create a directory (recursive) |
| `move(from, to, userId?)` | `Promise<void>` | Move or rename a file within the user's scope |
| `stat(path, userId?)` | `Promise<StatResult>` | Get file metadata (see [StatResult](#statresult) above) |
| `getJson<T>(path, options?)` | `Promise<T>` | Read and parse a JSON file. Options: `{ fallback?: T; userId?: string }` |
| `setJson(path, value, options?)` | `Promise<void>` | Serialize and write a JSON file. Options: `{ indent?: number; userId?: string }` |

`move` resolves both `from` and `to` under the same user's scope — cross-user moves are not supported.

**Storage location:** `{DATA_DIR}/users/{userId}/extensions/{identifier}/`

Path traversal is blocked — paths like `../../etc/passwd` will throw.
