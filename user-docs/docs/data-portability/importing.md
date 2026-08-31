---
title: Importing an Archive
---

# Importing an Archive

Import a `.lvbak` archive into your current Lumiverse account. Canonical rows
and files are non-destructive: an existing item with different content is not
overwritten. Ticket-restored secret values are an explicit exception and can
replace a same-named destination secret. Import can also add back content you
deleted after the export, so it is not a point-in-time rollback.

---

## Quick Import

1. Open **Settings → Data Portability**.
2. In the **Import an archive** card, choose your `.lvbak` file.
3. Click **Upload & import**.

The upload is accepted as a background job. The panel reports verification,
validation, an optional ticket wait, file installation, database commit, and
completion. You can leave the page and return to **Settings → Data
Portability** while the server process remains up. The job status is backed by
the durable import-control row and receipt, so the existing status endpoint can
recover the job after a server restart or after its in-memory status entry is
evicted. A committed receipt remains the idempotency authority.

Only one import is admitted for an account at a time, and the server also
limits process-wide import capacity. A second upload receives an
“import already in progress” response instead of creating a second large
staging tree.

---

## What Happens Before Any Live Data Changes

The server validates the whole archive before it writes canonical account
rows:

1. The raw request body is streamed into private import storage. ZIP magic
   bytes, the compressed-size limit, and the central directory are checked.
2. Every entry name is sanitized before it can be opened. Absolute paths,
   `..` traversal, duplicate names, unsupported buckets, and malformed table
   names are rejected.
3. Every ZIP entry is read in bounded windows. Its extracted byte count and
   CRC32 must match the ZIP central directory. V3 requires the exact 64 MiB
   NDJSON declaration; V1/V2 may omit the marker or advertise a smaller
   positive ceiling, but never above the 64 MiB hard limit. V3 entries carry a
   boolean `required` value and must match the manifest's byte count and
   SHA-256 ledger; file entries additionally require a frozen source identity
   whose size equals the entry bytes and must agree with registry requiredness.
4. NDJSON rows are materialized into a job-owned staging SQLite database.
   The staging database has the live table columns and registry-derived
   primary/unique indexes, but it is not the live account database.
5. The importer validates ownership, types, required columns, duplicate
   keys, secret indexes, file references, and the complete parent graph.
   Required archive-owned canonical parent rows must be present; nullable
   edges must be wholly null or wholly present; partial nullable keys are
   invalid. Owners cannot cross users. Instance-local or forbidden parent
   identities are validated as references, not materialized as archive rows.

An archive that fails any of these checks is rejected before canonical data is
committed. V3 has the closed authenticated manifest ledger: an unlisted
database, file, vector, or secret entry is not silently applied. V1 and V2
archives remain readable through the same ownership and graph validation path;
omitted legacy metadata receives compatibility defaults, while an advertised
smaller NDJSON ceiling is enforced. Legacy notification sounds are accepted
only as the descriptor-only `files/notification-sounds/completion.{mp3,wav,ogg,aac,m4a}`
path and still pass CRC32 and audio validation.

---

## How Conflicts Are Resolved

Rows are matched using the registry's primary and unique keys, not merely by
assuming that every table has one UUID:

| Situation | Outcome |
|-----------|---------|
| No matching primary or unique key exists | The validated row is inserted. |
| A matching row has identical values | The row is skipped. |
| A matching row differs in content | The job fails and the live database transaction rolls back; neither version is silently overwritten. |
| A settings key exists on both sides | Settings values are merged by the settings merge policy; the result is written in the same live transaction. |
| A destination file is absent | The validated file is installed before its row can be committed. |
| A destination file exists with the same digest | It is reused as **preexisting** and is never overwritten. |
| A destination file exists with a different digest | The job fails without replacing the destination file. |

An ordinary re-upload therefore cannot overwrite newer work. It creates a new
job: equal rows are skipped and digest-matching files are reused. Re-upload
the retained archive after a failed or cancelled job rather than deleting
destination files manually.

---

## Import Phases

The job moves through these durable phases:

1. **Queued** — the raw archive is persisted and the account import slot is
   reserved.
2. **Verifying / validating** — the ZIP, manifest, CRC32/SHA-256 entries,
   limits, staging database, file references, owners, unique keys, and parent
   graph are checked.
3. **Awaiting ticket** *(optional)* — an archive with encrypted secrets waits
   for the matching ticket. While it waits, the server parks the job's lease
   and releases its account/process admission slot; a restart leaves the
   durable job parked rather than treating it as interrupted. You may submit
   the ticket or choose **Skip API keys**; the existing action reopens the
   retained archive safely and resumes the gate. Skipping imports the rest
   without restoring secret values. A successful submit validates the ticket
   and carries its one-use tombstone into the same durable commit transaction
   as the re-encrypted secret values. Validation or any pre-commit failure
   leaves the ticket reusable; a committed receipt never rolls the tombstone
   back. Submit and skip are one gate: a duplicate or competing request is
   rejected.
4. **Ready** — validation is complete; the archive is no longer accepting
   input and the staged data is retained for controlled install/commit steps.
5. **Installing files** — each present required or optional file is journaled,
   flushed, installed without replacement, and checked again under the job
   lease. Optional omissions follow the archive's declared policy.
6. **Committing** — canonical rows, settings, owner rewrites, disabled
   execution policy, ticket-decrypted/re-encrypted secrets, the ticket
   one-use tombstone, and the import receipt are written in one synchronous
   SQLite transaction. The transaction either commits all of these together
   or rolls them back before the receipt exists.
7. **Complete** — the receipt is authoritative. When canonical rows require
   vectors, the receipt carries a bounded rebuild intent; the server schedules
   derived vector work afterward. A vector failure leaves an explicit
   rebuild-required/pending status and does not undo canonical data.

The database transaction is atomic for live relational data. Before that
transaction records the receipt, the importer stores only bounded canonical
source/vector identities—not raw vectors—in the receipt summary so a crash
cannot lose the projection work. Filesystem operations are not part of that
SQLite transaction: file installation is journaled and fenced separately, and
the receipt records the point at which the relational commit succeeded. This
ordering ensures that a committed row does not point at a required file that
was never installed, while still allowing recovery after a process or
filesystem failure.

After the receipt, the server attempts bounded vector scheduling. If the
process stops in that window, startup retries the pending per-account
projection before cleaning the owned staging area. A failed retry keeps the
receipt authoritative and records a recoverable `rebuild_required` /
`projectionPending` status and error; it never rolls back canonical rows or
files. A successful receipt never grants permission to replace a destination
file or replay canonical rows.

---

## Imported Authority and Secrets

Restoring account content does not restore authority to act on the destination
instance:

- LLM, image-generation, TTS, and STT connection rows are imported disabled;
  `has_api_key` is cleared. Re-enter credentials or use the ticket workflow.
- Imported agent execution configuration is disabled, marked for review, and
  limited to explicit Response mode until you repair and acknowledge it.
- Extension grants, sessions, active turns, workspaces, locks, decision
  tokens, and other runtime authority are not archive data and are never
  recreated. Canonical extension configuration rows are imported with their
  enabled state reset off; grants and runtime authority remain excluded.
- A valid ticket restores only encrypted secret *values*, re-encrypted under
  the destination identity key. If a same-named destination secret exists,
  its value is replaced by the imported value. A ticket does not restore
  activation, grants, or execution authority.

This reset is intentional even when the archive came from the same user. Review
connections, agent configuration, and any imported extensions before enabling
them.

---

## Cancellation, Crash Recovery, and Retry

To stop an upload before the server returns a job ID, abort the browser
request. After the upload returns `202` with a `jobId`, click **Cancel** while
the job is validating, waiting for a ticket, or installing files. The
cancellation signal is checked while archive chunks are read and before each
file and database phase. Before the live commit, the job records `cancelled`
and attempts cleanup only for files whose canonical journal path, staged/final
identity, digest, and absence from live relational references prove they were
created by this job.

Once the `committing` phase begins, cancellation returns **too late** (HTTP
409). The synchronous transaction is allowed to finish; a committed receipt
cannot be rolled back by a later cancel request.

If the process stops:

- A receipt means the relational import committed. Startup keeps the committed
  data, retries any bounded pending vector projection from the receipt's source
  identities, records success or recoverable `rebuild_required` /
  `projectionPending` state, and then cleans only the job-owned staging area. It
  never replays canonical rows, overwrites files, or rolls back the receipt.
- Without a receipt, startup takes over only after the old lease expires,
  increments the lease generation, and marks the interrupted job failed after
  removing only a job-created final path whose canonical journal path, staged
  and observed identity, byte count, digest, and absence from live relational
  references all match. Same-digest pre-existing or shared files are never
  eligible for removal.
- An unsafe or unexpected staging path is left for manual recovery rather than
  being removed by a broad recursive cleanup.

Re-upload the retained archive after a failed or cancelled job. Do not delete
destination files manually to “make room”; a digest mismatch is a safety
failure, not an invitation to overwrite.

---

## Limits and Rejections

| Cap | Value |
|-----|-------|
| Maximum compressed archive size | 5 GB |
| Maximum decompressed size during import | 20 GB |
| Maximum NDJSON record size | 64 MiB |
| Maximum entries in the archive | 500 000 |

These limits are enforced while streaming and staging, not after an
unbounded allocation.

| Problem | Response |
|---------|----------|
| Request is not a ZIP or begins with the wrong magic bytes | Rejected before staging (415). |
| Manifest has the wrong producer, schema, registry version, or missing/duplicate V3 ledger entry | Archive validation fails (422 where the route can classify it). |
| Entry uses an absolute or traversal path, duplicate name, unsupported table, or unsupported bucket | Entire import rejected. |
| CRC32, byte count, SHA-256, owner, parent, unique-key, secret-index, or file-reference check fails | No canonical live rows are committed; the job fails with a stable error. |

!!! warning "Keep an encrypted archive and ticket together"
    The ticket is bound to the archive ID and exact secret index. Submitting a
    ticket replaces same-named destination secret values; skip the ticket (or
    back up destination credentials first) if that replacement is not wanted.
    If you choose **Skip API keys**, the rest of the archive can still import,
    but that run does not restore the secret values.

!!! warning "Ticket consumption follows successful pre-commit preparation"
    Ticket validation and secret decryption/re-encryption happen before the
    commit fence. The one-use tombstone commits atomically with the secret
    rows, canonical graph, and receipt; a decrypt error, cancellation,
    filesystem failure, database rollback, or process crash before that
    transaction leaves the ticket reusable. Once the receipt commits, that
    destination account rejects replay permanently. Another destination does
    not share the tombstone and may accept the same archive/ticket pair before
    the ticket expires.

!!! warning "A merge can restore deleted content"
    Importing an older archive may add back characters, chats, presets, or
    files you deliberately removed after the export. For a clean restore, use
    a fresh account.
