---
title: API Keys & Tickets
---

# API Keys & Decryption Tickets

By default, exports **do not** include API keys or any other content from your `secrets` table — those stay encrypted at rest on the source server. If you want a 1:1 restore (no need to paste keys back in), enable **Include API keys**. This produces two files: the archive and a separate decryption ticket. The ticket contains the raw AES key, includes an issuer identity, expires after 24 hours, and is accepted at most once by each destination account and instance.

---

## What's Protected

The `secrets` table holds every credential Lumiverse encrypts at rest:

- LLM connection API keys
- Image-generation, TTS, and STT API keys
- Embedding-provider API keys
- The web-search API key
- MCP server headers and environment variables (often hold tokens)
- Anything a Spindle extension has written to its secure enclave storage

All of the above are bundled when you opt into the secrets flow. Connection profile metadata (provider, URL, model) still travels even without the ticket — only the key value itself is gated behind the ticket.

---

## Exporting With Keys

1. Open **Settings → Data Portability**
2. In the export card, tick **Include API keys & secrets (downloads a separate decryption ticket)**
3. Read the warning that appears, then click **Download archive**
4. Your browser downloads **two files in sequence**:

   | File | Contents |
   |------|----------|
   | `lumiverse-{user}-{timestamp}.ticket.json` | A ~700-byte JSON file with the AES-256 key that decrypts the secrets |
   | `lumiverse-{user}-{timestamp}.lvbak` | The archive itself, including a `secrets/encrypted.ndjson` blob |

   They share the same `HHMMSS` so they sort next to each other in any directory listing.

5. **Save the ticket somewhere different from the archive.** A password manager is ideal. Anyone who holds *both* files can decrypt your keys.

If any source secret cannot be enumerated or decrypted (legacy data, identity-key drift, or corruption), the key-bearing export fails as a whole. No partial ticket/archive pair is valid; repair the source secret and start a fresh export.

The ticket is also bound to the exact image-generation private-data and encrypted-secret inventory present during preparation. If either changes before the archive snapshot starts, the download fails closed; discard the old ticket and start a fresh export so the pair describes one source state.

If the archive download is interrupted or fails before completion, the server
restores the owner-bound pending export for a retry (or wipes it if the
bounded cache can no longer retain it). A successfully completed stream
consumes the pending export and wipes the in-memory master key.


---

## Importing With a Ticket

1. Upload the archive as usual via **Import an archive**
2. After upload + verify, if the archive carries encrypted secrets the import **pauses** in `Waiting for decryption ticket…`
3. You see a prompt: *"This archive carries N encrypted secrets. Upload your ticket file to restore them."*
4. Pick the matching `.ticket.json` file
5. The server validates the ticket and prepares each secret in bounded memory,
   then commits the ticket tombstone, decrypted/re-encrypted rows, canonical
   data, and receipt together in one durable transaction.

If you can't find the ticket, click **Skip API keys** — the import continues and you re-enter the keys manually in **Settings → Connections** afterwards.

### One-Use Tickets

Tickets expire after 24 hours. A destination account and instance can consume
a ticket only once for an archive ID. A replay on that destination, a stale
ticket, missing issuer fields, a wrong issuer, or a ticket for another archive
is rejected before any secret is decrypted or applied. Validation and secret
preparation happen before the commit fence, so decrypt failures, cancellation,
filesystem failures, and pre-commit database failures leave the ticket
retryable. Once the transaction commits, that destination stores a permanent
tombstone for the account, archive, and ticket identity. The tombstone is
local: another Lumiverse instance does not share it and may import the same
archive/ticket pair while the ticket remains within its 24-hour lifetime.

---

## The Cryptography In Plain English

| Step | What Happens |
|------|--------------|
| Export prepare | Server generates a random 256-bit AES key (the "secret master key"). |
| Export prepare | Server computes a SHA-256 binding hash over the archive ID, algorithm, and sorted exact secret-key list, and embeds it in the ticket together with issuer, issuer instance, and issue time. |
| Export archive stream | Server reads every bound secret with its local identity key, authenticates the original secret key as AES-GCM associated data, and writes the encrypted result into the archive. Any read/decryption failure aborts the export. |
| Export archive stream | The master key is wiped from memory when the archive stream settles. |
| Import upload | Archive is verified (ZIP magic + manifest parse). |
| Import ticket submit | Server validates every required ticket field, freshness, archive ID, and exact secrets hash. |
| Import secrets phase | Each secret is authenticated against its original key, decrypted with the ticket's master key, and immediately re-encrypted with this instance's identity key in bounded memory. Plaintext never touches disk or logs. |
| Import commit | The one-use tombstone, re-encrypted secret rows, canonical graph, and final receipt commit synchronously together. A failure before that transaction leaves the ticket retryable. |

---

## Threat Model

What this protects against — and what it doesn't:

| Scenario | Result |
|----------|--------|
| Archive stolen alone | Secrets blob is AES-GCM authenticated and computationally infeasible to brute-force. |
| Ticket stolen alone | Without the matching archive, the AES key decrypts nothing. |
| Both stolen together | Attacker can decrypt. **Defended operationally**: keep the files in different secure locations. |
| Archive or secret row tampered after export | Exact manifest/ticket binding or AES-GCM authentication fails; the import is rejected all-or-nothing before canonical commit. |

What it **cannot** protect:

- **A compromised target instance.** If the machine running the import is owned, the decrypted secrets land in its `secrets` table where any local admin could read them.
- **Offline brute force when both files are stolen.** The AES key is *the* key; anyone with both files and standard tooling can decrypt outside Lumiverse. There's no extra password layer.
- **Compromise of the source instance.** If someone already has root on the server that made the archive, they already had your secrets — the ticket flow doesn't change that.

---

## Tips & Caveats

!!! tip "Use a password manager for the ticket"
    The ticket is a small JSON file containing the raw 256-bit AES key and
    binding metadata. A destination's one-use tombstone does not revoke this
    file: anyone with both files can still decrypt the secrets offline. Keep it
    separate from the archive and upload it only to the matching import job.

!!! tip "Secret restore is all-or-nothing"
    A ticket covers the exact encrypted-secret set. You cannot selectively
    restore individual keys, and a malformed or corrupt secret row aborts the
    import rather than silently dropping a value.

!!! warning "If you lose the ticket, the keys in the archive are gone"
    There is no backdoor. Without the ticket's AES key, the encrypted secrets blob is just random bytes. The archive itself is still useful — everything else (characters, chats, presets, etc.) imports normally — you just won't get keys back.

!!! warning "Re-issuing a ticket means re-exporting"
    Each export has a unique ticket. You can't "regenerate" a ticket for an existing archive — you'd run a fresh export, which produces a new archive with its own paired ticket.
