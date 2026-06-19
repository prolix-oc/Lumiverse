# Databank

The **Databank** is Lumiverse's document knowledge base. Drop reference material into a databank — worldbuilding notes, character backstories, rulebooks, transcripts, scraped articles — and it becomes retrievable context during chat. Documents are chunked, vectorized, and either pulled in automatically based on what's being said, or summoned on demand with a `#slug` mention.

Think of it as a per-user research folder that the AI can flip through while it answers.

---

## How It Differs From World Books and Long-Term Memory

| System | Source | When It Activates |
|--------|--------|-------------------|
| **World Book** | Hand-authored short entries | Keyword match (and optionally vector match) on recent messages |
| **Long-Term Memory** | The current chat's own history | Semantic similarity to the current context |
| **Memory Cortex** | The current chat's history, but understood as entities/arcs | Salience- and entity-weighted retrieval |
| **Databank** | Documents *you upload* | `#slug` mentions in chat **and/or** automatic semantic retrieval |

World Books are for short, structured lore facts. Databanks are for long-form source material you want the AI to consult — chapter PDFs, design docs, full character bibles, transcripts.

---

## Scopes

Every databank belongs to one of three scopes:

| Scope | Available In | Use For |
|-------|--------------|---------|
| **Global** | All your chats | Reference material you want everywhere (a writing style guide, your favorite worldbuilding notes) |
| **Character** | Any chat using the bound character | Character-specific source material (their canonical backstory, an author's body of work) |
| **Chat** | A single chat | One-off material for a specific story or campaign |

A chat sees all currently-attached databanks at once — global + character-bound + chat-bound — so you can layer them.

### Attaching a Databank

1. Open the **Databank** drawer tab
2. Use the **Global / Character / Chat** scope tabs at the top of the panel
3. Pick the databank you want from the list, or click **Attach** to bind an existing global databank into the active character or chat

Chat documents auto-create a chat-scoped databank the first time you upload a file in that chat — no manual setup required.

---

## Uploading Documents

From the Databank panel, with a bank selected:

1. Click **Upload** (or drag files onto the panel)
2. Files are parsed, chunked, and embedded in the background

Each document shows a status badge while it's being processed:

| Status | Meaning |
|--------|---------|
| **pending** | Queued for processing |
| **processing** | Being chunked and embedded |
| **ready** | Available for retrieval |
| **error** | Failed — hover to see the message |

### Supported Formats

`.txt`, `.md`, `.markdown`, `.csv`, `.tsv`, `.json`, `.xml`, `.html`, `.htm`, `.yaml`, `.yml`, `.log`, `.rst`, `.rtf`

PDF, DOCX, EPUB, audio, and image OCR are **not** supported — convert those to Markdown or plain text first.

### File Size

Each file is capped at **10 MB**. There's no overall storage cap, but very large databanks (thousands of long documents) will use more disk and slow embedding rebuilds.

### Scrape a URL

Instead of downloading-then-uploading, paste a URL into the **Paste a URL to scrape…** field at the top of the document list. Lumiverse fetches the page, extracts the readable content, and ingests it as a new document.

---

## Slug Mentions (`#document-name`)

Every document gets an auto-generated, kebab-cased **slug** based on its name:

- `My Worldbuilding Notes.md` → `#my-worldbuilding-notes`
- `Chapter 12 - The Reckoning.txt` → `#chapter-12-the-reckoning`

Type `#` in the chat input and an autocomplete popover lets you pick a document from any attached databank. The mention is removed from the message before it's sent — the AI sees the document content instead.

**Sizing behavior:** if a full document fits within a 2,000-token budget, the entire text is injected. If it doesn't, Lumiverse runs a semantic search inside the mentioned document and injects the most relevant chunks. Either way, the inserted content is labeled with `[Source: <document name>]` so the AI knows where it came from.

**Renaming changes the slug.** If you rename a document, update any presets or chat templates that reference it.

---

## Automatic Retrieval

When you generate a message, Lumiverse also runs a semantic search across **every attached databank** using your recent chat context as the query. The top matching chunks are pulled in as additional context.

This requires:

- **[Embeddings](../settings/embeddings.md)** configured (any supported provider)
- At least one attached databank with `ready` documents

If embeddings aren't set up, documents are still parsed and chunked — but only `#slug` mentions work, since there's no way to run semantic search without a vector model.

---

## Settings

The Databank panel exposes a small settings section that applies **globally** to every databank you own:

| Setting | Description |
|---------|-------------|
| **Chunk Target Tokens** | Preferred chunk size (200–2000, default 800) |
| **Chunk Max Tokens** | Hard ceiling per chunk (200–4000, default 1600) |
| **Chunk Overlap Tokens** | Tokens of overlap between adjacent chunks (0–500, default 120) |
| **Retrieved Chunks** | Top-K chunks pulled per query (default 4) |

After changing chunk parameters, hit **Reprocess All** on any existing documents — old chunks aren't automatically resized.

---

## Document Operations

For each document, the panel offers:

- **Rename** — click the title to edit inline (updates the slug too)
- **Edit content** — click the body to open it in the inline editor; saved edits trigger re-chunking
- **Reprocess** — re-parse, re-chunk, and re-embed a single document
- **Delete** — remove the document and its chunks

The whole bank has:

- **Reprocess All** — useful after changing chunk settings
- **Fuse** — merge one databank into another. The source's documents are moved over, duplicates are collapsed by content hash, and any characters/chats attached to the source are rewired to the target. Handy for consolidating "my fantasy world" notes that ended up split across several banks.

---

## Macros

Databank content is available in your presets through dedicated macros:

| Macro | Returns |
|-------|---------|
| `{{databank}}` | Formatted databank chunks with a header section |
| `{{databankRaw}}` | The same chunks without the outer header |
| `{{databankActive}}` | `"yes"` or `"no"` — for conditional blocks |
| `{{databankCount}}` | Number of chunks retrieved this generation |

Aliases for `{{databank}}`: `{{databankMemory}}`, `{{documents}}`, `{{knowledgeBank}}`.

!!! note "The macro controls *placement*, not *whether* databank content injects"
    Like [long-term memory](memory.md), databank retrieval injects automatically whenever active banks return chunks. The `{{databank}}` macro only controls **where** that content appears — without it, retrieved chunks are inserted as a system message just before the chat history. To stop injection entirely, deactivate the bank for this chat/character or disable embeddings, rather than removing the macro.

Use `{{databankActive}}` to wrap databank content in a conditional so the section disappears cleanly when nothing retrieves:

```
{{if::{{databankActive}}}}
Relevant source material:
{{databankRaw}}
{{/if}}
```

---

## Tips

!!! tip "Use Markdown headings"
    The chunker respects Markdown section boundaries. Splitting a long document with `## Headings` produces tighter, more topical chunks and better retrieval than one giant wall of text.

!!! tip "Prefer the smallest scope that works"
    A chat-scoped databank with one document doesn't pollute every other chat. Promote it to global only once you're sure you want that material everywhere.

!!! tip "Slug-mention what you want guaranteed"
    Automatic retrieval is helpful but stochastic. If a particular document *must* be in the prompt for this turn, drop a `#slug` mention into your message — that bypasses semantic search and guarantees the content is injected.

!!! tip "Reprocess after big edits"
    Changing chunk settings doesn't retroactively resize existing chunks. Click **Reprocess All** when you tweak chunk targets so the new settings actually apply to existing documents.
