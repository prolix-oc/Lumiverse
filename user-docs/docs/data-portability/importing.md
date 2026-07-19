---
title: Importing an Archive
---

# Importing an Archive

Restore a `.lvbak` archive into your current Lumiverse account. The importer is **non-destructive** — your existing data is preserved, and only new content from the archive is added.

---

## Quick Import

1. Open **Settings → Data Portability**
2. In the **Import an archive** card, click the file picker and select your `.lvbak`
3. Click **Upload & import**

You'll see live progress as the import runs:

```
Uploading… 73%
Verifying archive…
Archive extracted, applying rows…
Applying messages (4218)…
Restoring files… 312/418
Vectors restored for chat_chunks
Import complete
```

When it finishes, a summary table shows how many rows were imported, merged, or skipped for each table.

---

## How Conflicts Are Resolved

Lumiverse uses UUIDs for every row, so archive IDs are globally unique. The import policy is **"merge by ID; skip if exists"**:

| Situation | Outcome |
|-----------|---------|
| Row in archive has an ID not present in your account | **Inserted** |
| Row in archive has the same ID as an existing row | **Skipped** — your version is preserved |
| Settings key (e.g. `imageGeneration`) exists on both sides | **Deep-merged** — your top-level choices win; nested arrays (like preset libraries) are unioned by ID |
| File on disk already exists with the same name | **Skipped** — your file is preserved |

This means re-importing the same archive is safe: nothing duplicates, nothing is overwritten.

!!! info "Why merge instead of replace?"
    Replace-style imports destroy any data you've created on the target since the archive was made. Merge keeps both — you get back what was missing without losing what's new.

---

## What Happens During Import

The import runs as a background job. You can keep using Lumiverse while it runs, but **don't close the tab** until you see the completion summary.

### Phases

1. **Uploading** — the archive streams from your browser to the server's import staging directory.
2. **Verifying archive** — the server checks the ZIP magic bytes during upload, then reads only the manifest entry to confirm it's a real Lumiverse archive (this is fast — milliseconds, even for multi-GB files).
3. **Awaiting ticket** *(optional)* — if the archive carries encrypted secrets, the import pauses for you to upload the matching decryption ticket. See [API Keys & Tickets](api-keys-and-tickets.md).
4. **Applying rows** — database rows are inserted in topological order so foreign keys resolve cleanly.
5. **Restoring files** — images, thumbnails, avatars, theme assets, databank documents, and your notification sound are copied into place.
6. **Restoring vectors** *(if present)* — LanceDB vectors are restored when the embedding config matches; otherwise marked for re-vectorization.
7. **Restoring secrets** *(if a ticket was provided)* — encrypted secrets are decrypted with the ticket, then re-encrypted under your instance's identity key.
8. **Complete** — summary shown in the panel.

### Cancellation

If you click **Cancel** mid-import, the job stops within a second or two. Anything already applied stays applied — merge semantics make this safe. You can re-upload the same archive to finish later.

---

## After the Import

A few things to verify:

- **Characters & chats** — open a familiar chat to confirm messages, swipes, and branches restored.
- **Active persona / preset** — restored from the archive, but you can switch in the usual place if your account already had different defaults.
- **Connections** — listed but **disabled** (the `has_api_key` flag is forced to 0). Re-enter your API key for each, or use the [ticket flow](api-keys-and-tickets.md).
- **Vectors** — if the embedding config didn't match, RAG and memory-cortex search will return empty results until background re-vectorization runs through your imported chunks. Watch progress in **Settings → Embeddings**.

---

## Limits and Safety

| Cap | Value |
|-----|-------|
| Maximum compressed archive size | 5 GB |
| Maximum decompressed size during import | 20 GB |
| Maximum NDJSON row size | 4 MB |
| Maximum entries in the archive | 500 000 |

These caps protect against zip bombs and malformed archives. Real archives, including 1.9 GB galleries with vectors, comfortably fit.

### What Gets Rejected

| Problem | Response |
|---------|----------|
| File doesn't start with `PK\x03\x04` (not a ZIP) | 415 — rejected before staging |
| Archive exceeds compressed cap | 413 — rejected before processing |
| Archive contains `..` or absolute paths in entry names | Entire import aborted |
| Manifest claims a different producer or unsupported version | 422 — rejected during verify |
| Decompressed size exceeds 20 GB | Aborted mid-extraction |

---

## Tips & Caveats

!!! tip "Foreign-key cycles are handled"
    The schema has cycles (e.g. characters reference images, but images can reference characters via `owner_character_id`). The importer disables foreign-key enforcement during the bulk apply, then runs a scrub pass to NULL out any references whose target wasn't restored. Affects only the importing user; other accounts' integrity is untouched.

!!! tip "Same archive on multiple instances is fine"
    The merge-by-ID policy means you can restore the same archive into half a dozen instances — your friends, a staging server, a backup machine. Each ends up with the same data, no duplicates if you re-run.

!!! warning "Encrypted secrets need their ticket"
    If the archive's manifest reports `hasEncryptedSecrets: true` and you don't supply the matching ticket file, the import will prompt you to either upload it or **Skip API keys**. Skipping is fine — you can always re-import later with the ticket if you find it.

!!! warning "Don't restore an old backup over fresh work"
    The merge is non-destructive, but it does **add back** characters, chats, or presets you deliberately deleted after the backup was taken. If you want a clean slate, create a new user account and import there.
