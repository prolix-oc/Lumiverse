---
title: Exporting Your Data
---

# Exporting Your Data

Export your account as a `.lvbak` archive. A `.lvbak` is a ZIP archive that
contains the account data that is safe to move between Lumiverse instances,
plus optional derived vectors and an optional encrypted-secret package.

---

## Quick Export (No API Keys)

1. Open **Settings → Data Portability**.
2. In the **Export your data** card, decide whether to **Include vector
   embeddings**.
3. Click **Download archive**.

Your browser saves a file named
`lumiverse-{your-username}-{YYYY-MM-DD}-{HHMMSS}.lvbak`. The timestamp makes
successive backups easy to sort. The archive is streamed to the download while
the server produces it; the server does not first assemble the whole archive in
memory.

---

## A Consistent Snapshot

An export is a point-in-time account snapshot, not a filesystem transaction.
Before it reads the rows or stages referenced files, Lumiverse takes an
account-level export barrier. Writes that change an archive-referenced row and
its file use the same barrier, so an export cannot intentionally pair an old
database row with a newly replaced file.

While the barrier is held, Lumiverse:

1. Opens a dedicated read-only database snapshot.
2. Finds the files referenced by the rows visible in that snapshot.
3. Opens each source file, records its filesystem identity (device/inode plus
   size and available timestamps), and computes its SHA-256 digest.
4. Copies each file through the open source descriptor into private,
   export-owned staging storage.
5. Checks the source identity, byte count, and digest again before accepting
   the staged copy.

Only after referenced files have been staged is the barrier released. Database
rows continue streaming from the same read snapshot, and only the staged file
copies are added to the archive. A required source file that is replaced or a
captured descriptor that changes while it is being staged stops the export
instead of producing a mixed-snapshot backup. An optional source is allowed to
be omitted only when its first lookup reports `ENOENT`; once the file is
present, an identity, timestamp, read, replacement, byte-count, or digest
failure stops the export as well. Retry after the write has finished.

When two logical references point to identical bytes, the archive stores one
payload and records the other path as an alias. Each logical alias retains its
own required/optional status; a required alias never changes the requiredness
of an optional payload path.

The database and filesystem do not commit as one filesystem transaction. The
barrier and read snapshot make the *input* coherent; the staged copies and
their manifest records make the exported bytes independently verifiable. The
download stream is backpressured with bounded queues, so a slow reader
throttles the export rather than accumulating the ZIP in memory.

---

## Choosing What to Include

### Vector Embeddings

| Choice | Effect |
|--------|--------|
| **On** (default) | Requests the supported derived-vector option. A stable per-user dump is included only when it is complete and has its own embedding identity; otherwise the manifest records `rebuild_required`. |
| **Off** | Omits vector entries. The imported canonical chunks and memory data can be re-vectorized after an embedding provider is configured. |

Vectors are derived data, not the source of truth. If the requested dump is
absent or incomplete, the manifest records `rebuild_required`; if vectors were
turned off, no vector payload is present. In either case, the destination must
rebuild vectors rather than treating a partial dump as canonical data.

### API Keys & Secrets

Secrets are a separate opt-in workflow with its own decryption-ticket file.
See [API Keys & Tickets](api-keys-and-tickets.md).

If you do not opt into that workflow, encrypted secrets are not included.
During ticket preparation, every candidate must be readable and decryptable.
An enumeration, identity-key, or decryption failure aborts the key-bearing
export; no candidate is silently excluded from the exact secret index. Repair
or re-enter the source secret and prepare a fresh export and ticket.
After a ticket is prepared, if any secret in its bound index is later missing or
cannot be decrypted during archive generation, the export aborts rather than
producing a partial secret package; discard the partial download and retry.

---

## What the Archive Contains

The archive is a ZIP file. New exports use the authenticated V3 layout:

```
manifest.json              Final archive ledger and snapshot metadata
database/                  NDJSON for registry-approved canonical tables
files/
  images/                  Original uploaded images
  thumbnails/              Pre-generated image thumbnails
  avatars/                 Character and persona avatar files
  databank/                Databank documents
  theme-assets/            Theme bundle files
  audio/                   User-owned audio files
  artifacts/               Published chat workspace artifacts
  notification-sounds/     Optional custom completion sound
lancedb/                   Optional derived vector dumps
secrets/
  index.json               Secret names covered by the ticket, when enabled
  encrypted.ndjson         Encrypted secret values, when enabled
```

`manifest.json` is written last. It records the archive ID, archive schema and
registry versions, the dedicated snapshot ID, row and byte counts, embedding
identity, optional-file omissions, and a sorted authenticated entry ledger.
Missing-file and alias paths are archive-relative names; the manifest never
contains host filesystem paths. Each database, file, vector, and
encrypted-secret entry has a byte count and SHA-256 digest; V3 file entries
also carry a frozen source identity whose size equals the staged bytes. V3
rejects duplicate entry names, missing or malformed ledger fields, and a
manifest that does not describe exactly the payload entries. Every NDJSON
record is capped at 64 MiB and every archive entry at 8 GiB.
Older V1/V2 archives remain importable through their compatibility path. They
may omit legacy metadata and the NDJSON marker, or advertise a smaller positive
record ceiling, but the hard ceiling remains 64 MiB. V1/V2 archives do not
carry the V3 ledger; descriptor-only completion sounds, when present, use the
allowlisted notification-sound path and are still CRC/audio validated.

The registry classifies every application SQLite table exactly once. SQLite
engine-owned `sqlite_*` tables are not application data and are the only schema
objects excluded from this coverage assertion:

- **Canonical** rows are account-owned data exported through the ownership and
  parent graph.
- **Derived** stores, such as vectors and caches, are optional rebuildable
  projections.
- **Operational** state is runtime control data and is not restored from an
  account archive.
- **Forbidden** tables include authentication, sessions, credentials,
  extension grants, push/device state, and SQLite search shadows.

The archive therefore does not copy live turns, workspaces, locks, decision
tokens, import-control rows, raw runtime carriers, or extension authority.
Those records are instance-local and must never be resurrected by restoring a
backup.

---

## Streaming and Performance

Rows and staged files stream into the ZIP in bounded chunks. The server does
not hold a multi-gigabyte archive in memory. A very large export can still
take time because every referenced file is read, hashed, staged, and verified
before it is sent.

If you are using nginx, NPMPlus, or another reverse proxy and the download is
much slower than your connection, the proxy may be buffering the response.
Lumiverse sends `X-Accel-Buffering: no`; if your proxy ignores it, use:

```nginx
proxy_buffering off;
proxy_request_buffering off;
proxy_max_temp_file_size 0;
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_set_header Accept-Encoding "";
gzip off;
proxy_read_timeout 600s;
proxy_send_timeout 600s;
client_max_body_size 0;
```

---

## If an Export Stops

An export that is interrupted, cancelled, or fails a source-identity check is
not a completed backup. Discard a partial download and start a new export.
The server removes its private staging tree during cleanup; it never treats a
partially streamed ZIP as valid merely because it has a filename.

If archive generation reports that a ticket-bound secret could not be
decrypted, no usable archive was completed. Discard the partial download,
repair or re-enter the source secret, and run the export and ticket workflow
again.

!!! warning "Keep the archive and ticket together"
    A ticket is bound to one archive ID and its secret index. Do not rename a
    ticket to use it with a different archive, and store both files securely.

!!! warning "An import is not a point-in-time rollback"
    Import merges into an existing account. It does not delete newer data or
    undo edits to rows that still exist. For a clean restore, import into a
    fresh account.
