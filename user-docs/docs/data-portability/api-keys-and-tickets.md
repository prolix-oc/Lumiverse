# API Keys & Decryption Tickets

By default, exports **do not** include API keys or any other content from your `secrets` table — those stay encrypted at rest on the source server. If you want a true 1:1 restore (no need to paste keys back in), enable the **Include API keys** option. This produces two files: the archive and a separate **decryption ticket** that holds the AES key.

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

If a secret on the source instance can't be decrypted (legacy data, identity-key drift), it's silently dropped from the export and surfaced in a yellow warning under the export button: *"N secrets could not be decrypted on this server and were excluded from the archive. Affected keys: …"*. The ticket only binds to the secrets that actually made it in, so the import-side binding check passes cleanly.

---

## Importing With a Ticket

1. Upload the archive as usual via **Import an archive**
2. After upload + verify, if the archive carries encrypted secrets the import **pauses** in `Waiting for decryption ticket…`
3. You see a prompt: *"This archive carries N encrypted secrets. Upload your ticket file to restore them."*
4. Pick the matching `.ticket.json` file
5. The server validates the ticket, decrypts each secret, and re-encrypts every value under your local instance's identity key before storing it

If you can't find the ticket, click **Skip API keys** — the import continues and you re-enter the keys manually in **Settings → Connections** afterwards.

### Reuse Is Allowed

Tickets never expire. You can restore the same backup multiple times — onto a fresh install, a backup machine, a staging server, after a disaster — and the ticket keeps working. The server records every use; on the second and subsequent uses you see:

> Heads up: this ticket has been used 2 times (last used 2026-05-21 14:30:52). Proceeding will overwrite any matching API keys on this account.

This is purely advisory. The import proceeds.

---

## The Cryptography In Plain English

| Step | What Happens |
|------|--------------|
| Export prepare | Server generates a random 256-bit AES key (the "secret master key"). |
| Export prepare | Server also computes a SHA-256 binding hash over the archive ID + algorithm + sorted secret-key list, and embeds it in the ticket. |
| Export archive stream | Server reads each secret with its local identity key, re-encrypts it with the master key using AES-256-GCM (fresh IV per record), and writes the result into the archive. |
| Export archive stream | Master key is wiped from memory the moment the archive download completes. |
| Import upload | Archive is verified (ZIP magic + manifest parse). |
| Import ticket submit | Server re-computes the binding hash from the archive and compares — mismatch means the archive was tampered with or the ticket is from a different export. |
| Import secrets phase | Each secret is decrypted with the ticket's master key, then immediately re-encrypted with this instance's identity key. Plaintext never touches disk and never leaves the import job's stack frame. |

---

## Threat Model

What this protects against — and what it doesn't:

| Scenario | Result |
|----------|--------|
| Archive stolen alone | Secrets blob is AES-256-GCM. Computationally infeasible to brute-force. |
| Ticket stolen alone | Without the matching archive, the AES key decrypts nothing. |
| Both stolen together | Attacker can decrypt. **Defended operationally**: you keep them in different places. |
| Archive tampered after export | Ticket binding hash no longer matches; import rejects with a `binding_mismatch` error. |
| Ticket tampered (e.g. swapped archive ID) | Import rejects with `archive_mismatch`. |
| Different archive's ticket used | Import rejects — ticket archiveId doesn't match the archive manifest. |
| Bit-flipped ciphertext inside the archive | AES-GCM auth tag fails; that individual secret is skipped during import. |

What it **cannot** protect:

- **A compromised target instance.** If the machine running the import is owned, the decrypted secrets land in its `secrets` table where any local admin could read them.
- **Offline brute force when both files are stolen.** The AES key is *the* key; anyone with both files and standard tooling can decrypt outside Lumiverse. There's no extra password layer.
- **Compromise of the source instance.** If someone already has root on the server that made the archive, they already had your secrets — the ticket flow doesn't change that.

---

## Tips & Caveats

!!! tip "Use a password manager for the ticket"
    The ticket is ~700 bytes of JSON. Most password managers let you attach a small file or paste the JSON as a secure note. That's the cleanest way to keep it durable and separate from the archive.

!!! tip "Restore on a per-key basis"
    There's no way to selectively restore just *some* secrets from a ticket — it's all or nothing per import. If you want different secrets per instance, run the export with **Include API keys** unchecked and re-enter the specific keys by hand on each target.

!!! warning "If you lose the ticket, the keys in the archive are gone"
    There is no backdoor. Without the ticket's AES key, the encrypted secrets blob is just random bytes. The archive itself is still useful — everything else (characters, chats, presets, etc.) imports normally — you just won't get keys back.

!!! warning "Re-issuing a ticket means re-exporting"
    Each export has a unique ticket. You can't "regenerate" a ticket for an existing archive — you'd run a fresh export, which produces a new archive with its own paired ticket.
