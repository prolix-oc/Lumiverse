---
title: Data Portability
---

# Data Portability

Move your entire Lumiverse account between machines, take periodic backups, or hand a fully-loaded environment off to another instance. Data Portability bundles **everything you own** into a single portable archive that any Lumiverse 1.0+ instance can restore.

---

## What's in an Archive

An archive (a `.lvbak` file — really a renamed ZIP) carries every piece of data tied to your user account:

| Domain | What's included |
|--------|----------------|
| **Characters** | Cards, avatars, alternate greetings, expressions, gallery images, tags |
| **Chats** | Every message, swipe, branch, group chat metadata, message breakdowns |
| **Personas** | All personas, pronouns, attached world books, persona–character bindings |
| **World Books** | Books and entries with full settings (sticky, cooldown, regex, groups, vectorization status) |
| **Presets** | Chat presets, image-gen prompt presets, prompt blocks, samplers |
| **Connections** | LLM, image-gen, TTS, STT connection profiles (without API keys — see below) |
| **Memory Cortex** | Entities, relations, consolidations, font colors, vaults, interlinks |
| **Databanks** | Knowledge banks, documents, chunks |
| **Packs** | Lumia, Loom, and tool packs — both user-authored and downloaded |
| **Theme Assets** | Bundles, custom CSS, wallpapers |
| **Settings** | Every preference — display, chat behavior, voice, push, extensions |
| **Spindle Extensions** | User-installed extensions and their enclave-stored preferences |
| **Notification Sound** | The custom completion sound, if you've uploaded one |
| **Images** | Every uploaded image *plus* its pre-generated thumbnails (no re-processing on import) |

Optionally, you can include:

- **Vector embeddings** — restores instant search/RAG/memory cortex retrieval without waiting for re-vectorization
- **API keys and secrets** — encrypted with a one-time decryption ticket (see [API Keys & Tickets](api-keys-and-tickets.md))

---

## What's Excluded

These never leave your instance:

- **API keys at rest** — unless you opt into the decryption-ticket flow
- **Web Push subscriptions** — they're tied to specific browser/device pairs and are useless elsewhere
- **System / auth tables** — your account row, sessions, OAuth tokens
- **Operator-installed extensions** — only user-installed ones travel
- **Runtime caches** — query vector cache, embedding cache (regenerated on demand)

---

## When to Use Each Flow

| Use Case | Read |
|----------|------|
| Moving to a new server / fresh install | [Exporting Your Data](exporting.md) → [Importing an Archive](importing.md) |
| Periodic backup | [Exporting Your Data](exporting.md) (run on a schedule) |
| Migrating between two of your own accounts | Export from source → Import into target |
| Including API keys for a true 1:1 restore | [API Keys & Tickets](api-keys-and-tickets.md) |
| Sharing a single character / world book / preset | Use the per-feature export (Character → Export, World Book → Export, etc.) — Data Portability is for the *whole* account |

---

## Where to Find It

**Settings → Data Portability**

The panel has two cards: **Export your data** and **Import an archive**.

!!! tip "Archives are forever"
    Archives never expire and have no time-bound license. You can store a `.lvbak` for years and restore it into any compatible Lumiverse instance. The same applies to decryption tickets — they have no TTL.
