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

// List files
const files = await spindle.userStorage.list(undefined, userId)

// Check existence
const exists = await spindle.userStorage.exists('config.json', userId)

// Create directory
await spindle.userStorage.mkdir('cache/', userId)

// Delete
await spindle.userStorage.delete('notes.txt', userId)
```

### User Storage Methods

| Method | Returns | Description |
|---|---|---|
| `read(path, userId?)` | `Promise<string>` | Read a file as UTF-8 text |
| `write(path, data, userId?)` | `Promise<void>` | Write a UTF-8 text file (creates directories as needed) |
| `delete(path, userId?)` | `Promise<void>` | Delete a file |
| `list(prefix?, userId?)` | `Promise<string[]>` | List files, optionally under a prefix/directory |
| `exists(path, userId?)` | `Promise<boolean>` | Check if a file or directory exists |
| `mkdir(path, userId?)` | `Promise<void>` | Create a directory (recursive) |
| `getJson<T>(path, options?)` | `Promise<T>` | Read and parse a JSON file. Options: `{ fallback?: T; userId?: string }` |
| `setJson(path, value, options?)` | `Promise<void>` | Serialize and write a JSON file. Options: `{ indent?: number; userId?: string }` |

**Storage location:** `{DATA_DIR}/users/{userId}/extensions/{identifier}/`

Path traversal is blocked — paths like `../../etc/passwd` will throw.

---

## User-data archive storage (core)

Extension storage and account-archive storage are different surfaces. The
Spindle `storage` and `userStorage` APIs above are scoped to an extension
directory. They are not an implicit source for `.lvbak` exports. Account
archives read only the core registry and the file references declared by that
registry.

### Closed archive registry

`src/services/user-data/table-registry.ts` exports
`ARCHIVE_REGISTRY_VERSION = 3` and one frozen
`ARCHIVE_TABLE_REGISTRY: readonly ArchiveTableSpecV2[]`. A spec is the only
authority for a SQLite table's archive behavior:

```ts
interface ArchiveTableSpecV2 {
  table: string
  kind: 'canonical' | 'derived' | 'operational' | 'forbidden'
  owner: ArchiveOwnerDerivationV2
  primaryKey: readonly string[]
  uniqueKeys: readonly (readonly string[])[]
  parentEdges: readonly ArchiveParentEdgeV2[]
  mergePolicy: 'upsert' | 'insert_only' | 'rebuild' | 'discard'
  authorityReset: 'preserve' | 'disabled' | 'review_required'
    | 'rebuild' | 'discard' | 'never_import'
  fileRefs: readonly ArchiveFileRefV2[]
  extraWhere?: string
  lancedb?: { name: string; idColumn?: string }
}
```

`ArchiveFileRefV2` is:

```ts
interface ArchiveFileRefV2 {
  bucket: 'images' | 'thumbnails' | 'avatars' | 'databank'
    | 'theme-assets' | 'audio' | 'artifacts'
  required: boolean
  onMissing: 'abort' | 'null_reference' | 'skip_dependent_row'
    | 'preserve_absent'
  pathColumn?: string
  bytesColumn?: string
  resolve(row: Record<string, any>, dataDir: string): string[]
  archivePath?(row: Record<string, any>, absolutePath: string): string
}
```

The `notification-sounds/completion.{mp3,wav,ogg,aac,m4a}` file is a
descriptor-only optional archive entry validated by the export/import services;
it is not represented by a table-registry `ArchiveFileRefV2`.

Canonical specs also declare required and optional file references. Each file
reference carries a bucket, path resolver, requiredness, and an explicit
`abort`, `null_reference`, `skip_dependent_row`, or `preserve_absent` policy.
Required references must abort when absent; optional references cannot use the
abort policy.

The four kinds are security boundaries, not labels for UI:

- **canonical**: user-owned rows and content-addressed published artifacts
  that can be restored through ownership, key, and parent validation. This
  includes the `audio_files` rows and their audio bytes and
  `agent_published_workspace_artifacts` rows and their artifact bytes.
- **derived**: rebuildable projections such as chunks, caches, and vector
  stores. They never make canonical import succeed or fail after the receipt.
- **operational**: live control-plane state, including activity projections,
  active runtime/import rows, leases, file journals, receipts, turn/workspace
  state, and multiplayer state. It is excluded from account archives.
- **forbidden**: authentication/session/account identity, secrets, extension
  grants, push/device state, tokenizer configuration, and FTS virtual/shadow
  tables. It is never archive input.

Extension rows are canonical configuration data, not the same as
`extension_grants`. On foreign import, their enabled state is reset off;
grants and runtime authority remain excluded.

`assertArchiveRegistryCoverage(db)` requires exactly one spec for every
application table in `sqlite_schema`; SQLite engine-owned `sqlite_*` tables
are the only schema objects excluded. A missing spec, missing declared
key/owner/edge column, duplicate spec, malformed edge, or registry parent
cycle throws. `getCanonicalImportOrder()` is a deterministic parent-first
order; it is computed from declared edges, not from incidental array order.
Run this assertion at startup and before materializing an import; a new
migration must not become accidentally importable.

### Frozen export snapshots

`src/services/user-data/snapshot.ts` provides the per-user
`UserDataSnapshotBarrier` and these writer/export helpers:

```ts
withUserDataMutation(userId, callback, signal?)
withUserDataMutationSync(userId, callback)
withUserDataExport(userId, callback, signal?)
openUserDataReadSnapshot(userId): {
  db: Database
  snapshotId: string
  files: readonly FrozenFileDescriptorV1[]
  close(): void
}
```

Mutations share the barrier. Export acquires the exclusive side with FIFO
fairness; once an exclusive waiter is queued, later mutations wait. Ordinary
core writers that change an archive-referenced row or file must hold the same
barrier around the atomic file replacement and relational mutation. Import
file installation is a separate journaled/fenced protocol and does not use
this export barrier as a filesystem transaction. A new ordinary writer that
bypasses the barrier can create a row/file pair that no export can prove
coherent.

`openUserDataReadSnapshot()` opens a dedicated read-only `bun:sqlite`
connection, enables `query_only` and foreign keys, and begins one deferred read
transaction before the first snapshot query. `FrozenFileDescriptorV1` binds:

```ts
{
  kind, ownerTable, ownerKey, owner: { table, key }, path, required,
  sourceRoot, sourceIdentity: {
    device, inode, size, mtimeMs, ctimeMs, birthtimeMs, mode
  },
  bytes, sha256, archivePath?
}
```

The source descriptor is opened and hashed, then copied to a private immutable
staging file through that descriptor. Identity, byte count, and SHA-256 are
checked again after the copy and before the barrier is released; the staged
copy is hashed once more while the archive entry is streamed. A required source
replacement, symlink escape, or captured-descriptor size/digest mismatch
aborts the export. An optional reference may be omitted only when its initial
lookup returns `ENOENT`; once present, identity, timestamp, read, replacement,
byte-count, or digest failures abort as well. Never accept a changed captured
file as the same archive object.

When multiple logical references share identical bytes, one payload entry is
stored and the remaining paths are manifest aliases. Alias requiredness is
recorded per logical reference; a required alias does not promote an optional
payload path.

`buildExportStream()` holds the exclusive barrier only through file
enumeration/staging. It keeps the read snapshot open while canonical rows
stream, emits only staged file bytes, and appends `manifest.json` last.
The NDJSON and binary producers await archive-stream drain, while the HTTP
sink honors `ReadableStream.desiredSize` with a bounded queue; a slow reader
therefore throttles export instead of accumulating ZIP bytes in memory.
`ArchiveEntry` records `path`, `kind`, `required`, `bytes`, `sha256`,
optional `rowCount`, and a frozen `sourceIdentity` for every V3 file entry;
its recorded size must equal `bytes`. `EntryLedger` rejects duplicate names.
V3 manifests carry the registry version, snapshot ID, archive ID, sorted entry
ledger, row/byte counts, frozen file aliases, missing optional references, and
embedding identity/status. A derived-vector payload is never canonical; when a
requested stable per-user dump is absent or incomplete, the manifest/status
records `rebuild_required`; when vectors are explicitly omitted, no vector
payload is present and the destination must rebuild it. V1/V2 manifests remain
parseable under bounded compatibility limits: omitted legacy metadata receives
defaults, and an advertised positive NDJSON ceiling may be smaller but never
exceeds 64 MiB. V1/V2 have no authenticated entry ledger; their legacy
completion sound descriptor, when present, is restricted to the allowlisted
path and still passes CRC/audio validation. All formats feed the current
ownership/graph validation on import.

### Secret export

When optional secret export is requested, the prepare route enumerates and
reads every candidate key under the source identity before issuing the ticket.
Any enumeration, read, identity-key, or decryption failure aborts preparation;
the route never filters a failed key or creates a partial ticket/archive pair.
On success, the ticket binds the archive ID and complete exact secret index,
and the closed response field is always `unreachableSecrets: []`. A
later missing row or decryption failure for any bound key aborts archive
generation rather than producing a usable partial secret package.
Legacy NanoGPT and NovelAI setting credentials are normalized before ticket
admission. Encryption happens before SQLite; the scrubbed setting CAS, active
connection identity, profile/default rows, and encrypted secret rows then commit
in one synchronous transaction. Connection and settings events are emitted only
after commit, so a CAS or statement failure exposes no staged profile.

### Import validation and staging database

The authenticated user-data routes are:

| Method | Route | Contract |
|---|---|---|
| `GET` | `/api/v1/user-data/export` | Streams a no-secret `.lvbak`; `includeVectors=0` omits vector dumps. |
| `POST` | `/api/v1/user-data/export/prepare` | Accepts `{ includeVectors, includeSecrets: true }`; after all-or-nothing secret admission, returns `{ archiveId, archiveUrl, archiveFilename, ticketFilename, ticket, secretsCount, unreachableSecrets: [] }`. |
| `GET` | `/api/v1/user-data/export/archive/:archiveId` | Consumes the prepared binding and streams the archive. |
| `POST` | `/api/v1/user-data/import` | Streams a raw ZIP request body, validates its manifest, and returns `{ jobId, status }` with `202`. Multipart bodies are rejected to avoid materializing a multi-GB body. |
| `GET` | `/api/v1/user-data/import/:jobId/status` | Returns the owner-scoped durable job state (with manifest, public table counters, `fileSummary`, and stable error); it falls back to the durable import-control row and receipt after in-memory retention or process restart. |
| `POST` | `/api/v1/user-data/import/:jobId/cancel` | Returns `cancelled`, `too_late`, or owner-scoped `not_found`. |
| `POST` | `/api/v1/user-data/import/:jobId/ticket` | Verifies and submits the archive's decryption ticket. |
| `POST` | `/api/v1/user-data/import/:jobId/skip-ticket` | Releases an `awaiting_ticket` job without restoring secrets. |

The public import route does not accept a caller-supplied idempotency key; it
uses the generated job identity. Internal callers may pass an idempotency key
to `startImport()`, and receipt replay is then handled by the durable unique
constraint. `startImport()` is asynchronous: callers without the opaque
proof returned by `persistUploadedArchive()` must let it compute a bounded
SHA-256/stat snapshot, and caller-provided digest/byte-count fields are never
trusted on their own. `getJob()` first serves the live in-memory projection
and then hydrates the owner-scoped status from `user_data_imports` and
`user_data_import_receipts`, so status remains recoverable after a restart or
terminal projection eviction. A receipt is authoritative and is never replayed
as a second canonical import.
For a parked `awaiting_ticket` job, `parkImportForTicket()` CAS-clears the
lease owner and expiry and releases in-memory admission. Startup
`reconcileUserDataImports()` leaves an ownerless parked row untouched. The
ticket and skip actions call `reloadParkedImportForAction()` when no in-memory
job exists; it revalidates and restages the retained archive, reacquires a
fresh lease generation, and rebuilds the one-use gate before the action
continues. A V1 archive with no archive ID receives the stable
`legacy-v1:<sha256("lumiverse:lvbak:v1:" + archiveDigest)>` identity before
staging, so digest-based retries retain the same durable idempotency identity.

`extractArchive()` validates entry names and central-directory declarations
before opening per-entry staging files. It streams decompression through fixed
windows, bounds compressed/decompressed/text sizes, verifies every entry's
CRC32 and extracted size, and rejects duplicate names. It does not apply
database rows or use an unbounded object graph.

`materializeValidatedArchive()` creates a job-owned staging SQLite database
using the live table columns and registry-derived unique indexes. It rejects
unknown tables and columns, missing required columns, malformed SQLite values,
duplicate primary/unique keys, mixed owner identities, cross-user owners,
secret-setting rows, undeclared file references, requiredness mismatches,
malformed optional omissions, invalid audio/artifact descriptors, and secret
index/row mismatches. V3's manifest is a closed payload ledger: every actual
database, file, vector, or secret payload must be declared and every declared
payload must be present.

Legacy message rows may contain provider-private `reasoningCarrier` or
`reasoningCarrierBySwipe` fields in `messages.extra`. The exporter removes
those fields recursively, and import materialization drops them before any
staged or live row can expose them; ordinary visible message metadata remains
portable.

For every staged table, `validateParentEdges()` checks each registry edge
before live apply. Composite edges must have matching arity; nullable edges
must be all null or all present; required parents must be staged; and present
parent keys must resolve in the staging graph. Operational/forbidden targets
are not archive-owned parent rows. `getCanonicalImportOrder()` supplies the
same parent-first order to the live apply. There is no post-import orphan
scrub that can turn a malformed archive into valid data.

Current safety ceilings are 5 GiB compressed upload, 20 GiB declared and
extracted bytes, 64 MiB per NDJSON record, 8 GiB per payload entry, 500,000
ZIP entries, 2,000,000 staged canonical rows, and 500,000 rows per staged
table. Older archive formats use explicit bounded compatibility handling.

### Journaled files and atomic live apply

Migration `src/db/migrations/115_user_data_import_integrity.sql` creates:

- `user_data_imports`, keyed by `job_id`, with `user_id`, archive and
  idempotency identity, archive digest, bounded manifest/staging references,
  `queued | validating | awaiting_ticket | installing | ready | committing |
  committed | failed | cancelled` state, lease owner/expiry, monotonic
  `lease_generation`, timestamps, summary, and bounded stable error. A partial
  unique index permits at most one nonterminal import per user.
- `user_data_import_files`, keyed by `id`, with archive/staged/final paths,
  kind, SHA-256, byte count, requiredness, install token, staged identity,
  observed final identity, omission policy, and
  `pending | preexisting | created | installed | removed | skipped` state.
  `(job_id, archive_path)` and `(job_id, install_token)` are unique.
- `user_data_import_receipts`, keyed by `receipt_id`, with job/user/idempotency
  identity, archive digest, deterministic summary, commit time, and unique
  `(user_id, idempotency_key)`.

`transitionImport()` and `assertCurrentFence()` compare both the lease owner
and generation. `renewImportLease()` is an internal helper invoked before each
file operation; the bounded import lease is 300 seconds. `installValidatedFiles()`
checks the fence before each file and after flushing the destination directory,
before recording the observed identity and state. A stale owner must stop; it
cannot transition a newer lease.

`installValidatedFiles()` installs every present validated file before the
live rows can reference it:

1. Re-hash and size-check the immutable staged file and its manifest entry.
2. Record a `pending` file-journal row with staged identity and install token.
3. Flush the staged file, then use an atomic no-replace hard link.
4. If link identity is unavailable across filesystems, choose a job-unique
   content-addressed destination and copy with exclusive create.
5. Reuse an existing destination only when it is a regular file with the
   same digest; record it as `preexisting`, never overwrite it.
The live relational commit is separate but atomic. `applyStagedArchive()` checks
the fence, prepares bounded ticket-decrypted/re-encrypted secret values in
memory, computes a bounded `VectorProjectionIntent` containing canonical
source/vector identities (never raw vectors), enters `committing`, and runs one
synchronous transaction over canonical rows in parent-first order, settings
merge, owner rewrites, disabled authority state, secrets, the ticket
one-use-consumption tombstone, and the receipt. Ticket validation and secret
preparation happen before this transaction; a statement failure or cancellation
before the receipt leaves the ticket reusable. Once the receipt commits, the
tombstone and canonical writes are final together. Existing equal rows are
skipped; different canonical values fail the transaction. A receipt is the
only durable proof that canonical data committed.
The running job then schedules derived vector projection; a queue failure keeps
the receipt authoritative with `rebuild_required`/`projectionPending` state and
recoverable error evidence.
Every delayed chunk, vector, cache, and import-rebuild continuation is admitted
against the current SQLite database generation and receives that generation's
abort signal. Closing or replacing SQLite publishes the raw previous/next
generation pair outside inherited async context, aborts queued work
synchronously, and requires registered replacement fences to drain before the
new generation is installed.

LanceDB has a separate centralized generation owner. Every native mutation path
(including merge-insert, table creation, delete, index creation, optimize,
startup repair, and migration) admits an owner before its first asynchronous
wait. Queued and active owners are both visible to replacement. Replacement
blocks new admission, cancels deferred optimize, retires every prior owner, and
drains owners plus native reads before closing handles or deleting files.
External maintenance children use the same owner; retirement sends SIGTERM,
waits up to two seconds, escalates to SIGKILL, and awaits child exit before the
owner releases. An in-process native Lance call cannot be interrupted safely,
so replacement waits for that admitted call to return rather than claiming an
unbounded no-hang guarantee.

The active vector-store handle is retired before its asynchronous close begins,
and lifecycle operations are serialized. A queued lookup therefore cannot
receive the old handle after replacement. Runtime configuration transitions
await close/reconciliation before publishing settings or credentials. Close or
SQLite reconciliation failure rejects the transition, publishes no new config,
and leaves the next lookup to construct a fresh handle from the still-current
configuration.
Owner-scoped image-connection mutation serialization uses revocable async leases.
Awaited same-owner nested service calls may re-enter while the lease is active,
but a detached callback that inherited the async context must queue normally once
the outer critical section releases. Different owners remain independent.

Do not describe this as one filesystem transaction: SQLite can roll back the
relational transaction, but it cannot roll back a hard link or copy. The
journal, creator identity, digest, lease fence, receipt, and bounded projection
intent provide convergence and recovery evidence instead. File installation is
pre-commit so committed rows cannot point to missing required bytes. If the
process stops after the receipt but before projection scheduling, startup
retries the pending per-user projection before cleaning owned staging; a failed
retry leaves explicit rebuild-required state and never overwrites a canonical
file or rolls back the receipt.

`authorityResetRow()` applies the registry's string policy and any
object-shaped reset map, plus table safeguards. `disabled`, `review_required`,
agent-config, context-ACL, and `extensions` rows are reset as appropriate:
connection/extension activation flags are cleared, agent review state becomes
`review_required`, imported agent modes are restricted to `response`, chat
agent-mode overrides are cleared, and imported context ACL principals are
rewritten to the destination owner. It also clears `has_api_key`. Ticket
success restores values only; it never restores grants, activation, locks, or
runtime authority. `extension_grants`, secrets-at-rest, sessions, active
turn/workspace rows, decision tokens, and import-control tables are registry
forbidden/operational and never enter account archives. Imported extension
configuration rows are canonical but their enabled state is reset off.

### Pre-bundle SQLite backup and downgrade boundary

Migration `113` is the first migration in this schema bundle
(`PRE_BUNDLE_MIGRATION_NUMBER`). `runMigrations()` calls
`ensurePreBundleBackup()` (`src/db/migrate.ts`) before `_migrations` is created
and before any baseline or migration SQL executes, so upgrading an existing
install always leaves a recovery point at
`<database path>.pre-bundle-113.sqlite` (`PRE_BUNDLE_BACKUP_SUFFIX`). The copy
sits next to the database, is retained across later migration runs, and its path
never reaches logs or error messages.

It is verified, not merely written: the source passes `PRAGMA integrity_check`,
`VACUUM INTO` produces a temporary file that is fsync'd and validated, an atomic
no-replace hard link installs it, the directory is fsync'd where the platform
exposes directory handles (Windows relies on the flushed file plus the atomic
no-replace link), and the installed file is validated again.
clean `integrity_check`, a `_migrations` list strictly below `102`, and a
matching schema identity — `user_version`, `application_id`, `page_size`, and
the exact migration name list. `VACUUM INTO` legitimately bumps the
destination's `schema_version`, so that pragma is proved per copy but is not an
identity key. Any failure deletes the temporary file and aborts startup; an
existing recovery point is validated and never replaced.

The backup is skipped only where there is nothing to protect or nothing new to
apply: in-memory databases, a fresh database with no user schema, a database
that already recorded a migration at or above `102`, and a run whose bundle
migrations are all recorded. A `file:` URI database name is rejected instead of
being treated as a filesystem path.

Downgrade boundary: these migrations are one-way, and running an executable from
before the bundle against the upgraded schema is unsupported — the older code
does not know the new tables, ledger states, or reset policies. To return to
that build, restore `<database path>.pre-bundle-113.sqlite` alongside the
matching older executable rather than downgrading in place; anything written
after the upgrade is not in that copy. Rolling back only the strict Agentic
runtime needs no schema change — use the `LUMIVERSE_AGENTIC_RUNTIME` switch in
[Generation > Operational rollback switch](generation.md#operational-rollback-switch).

### Startup reconciliation and cancellation

`reconcileStartupState()` runs after migrations and before routes, providers,
or extensions, in this order: start the runtime epoch, then
`reconcileUserDataImports()`, artifact-journal reconciliation, turn
reconciliation, isolate health, readiness, and coordinator installation.
Import reconciliation first checks for a receipt:

- With a receipt, it first retries any bounded pending vector projection from
  the receipt's source identities, records success or recoverable
  `rebuild_required`/`projectionPending` error state, then marks the control
  row committed if necessary, retains canonical data, and removes only the
  owned staging directory.
- Without a receipt and with an expired lease, it increments the fence and
  invokes the journal cleanup for a final path whose canonical creator/staged
  identity, observed identity when present, byte count, SHA-256, and
  no-live-relational-reference checks all match, then marks the job
  `process_interrupted`. Same-digest pre-existing/shared files are never
  eligible for removal.
- An untrusted staging path is retained and marked
  `manual_recovery_required`; startup never broadens deletion to an arbitrary
  path.

Cancellation aborts extraction, validation, ticket wait, and file staging
while they are reversible. Once `commitStarted` or the durable state is
`committing`, the cancel route returns `too_late` and the transaction owns the
outcome. On a pre-receipt failure, `rollbackCreatedFiles()` is
creator/path/identity/digest/no-live-reference gated. On a duplicate
`(user_id, idempotency_key)` for an internal caller, the receipt summary is
returned without reinstalling files or secrets. This is the retry contract; it
is not permission to delete or replace a destination path after a digest
mismatch.
