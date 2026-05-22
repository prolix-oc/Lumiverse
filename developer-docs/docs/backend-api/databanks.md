# Databanks

!!! warning "Permission required: `databanks`"

Full CRUD access to the user's databanks and their documents. Use this for extensions that manage imported knowledge sources, attach reference material to chats or characters, or build document-driven workflows on top of Lumiverse's chunking and vectorization pipeline.

## Usage

```ts
// List databanks (optionally filter by scope)
const { data, total } = await spindle.databanks.list({
  limit: 20,
  offset: 0,
  scope: 'character',
  scopeId: 'character-id',
})

// Get a single databank
const bank = await spindle.databanks.get('databank-id')
if (bank) {
  spindle.log.info(`Found: ${bank.name} (${bank.scope})`)
}

// Create a databank
const newBank = await spindle.databanks.create({
  name: 'Session Notes',
  description: 'Imported notes for the active campaign',
  scope: 'chat',
  scope_id: 'chat-id',
})

// Update a databank
await spindle.databanks.update(newBank.id, {
  description: 'Imported notes and clues for this campaign',
  enabled: true,
})

// Upload a document (processed asynchronously after creation)
const bytes = new TextEncoder().encode('# Session Recap\n\nThe party entered the ruins...')
const doc = await spindle.databanks.documents.create(newBank.id, {
  filename: 'session-recap.md',
  mime_type: 'text/markdown',
  data: bytes,
})

// Poll the document until processing finishes
const refreshed = await spindle.databanks.documents.get(doc.id)
spindle.log.info(`Document status: ${refreshed?.status}`)

// Read extracted content once ready
const content = await spindle.databanks.documents.getContent(doc.id)
if (content) {
  spindle.log.info(content.content)
}

// Reprocess a document
await spindle.databanks.documents.reprocess(doc.id)

// Delete the document, then the databank
await spindle.databanks.documents.delete(doc.id)
await spindle.databanks.delete(newBank.id)
```

## Methods

### Databanks

| Method | Returns | Description |
|---|---|---|
| `list(options?)` | `Promise<{ data: DatabankDTO[], total: number }>` | List databanks. Options: `{ limit?, offset?, scope?, scopeId? }`. Defaults: limit 50, max 200. |
| `get(databankId)` | `Promise<DatabankDTO \| null>` | Get a databank by ID. Returns `null` if not found. |
| `create(input)` | `Promise<DatabankDTO>` | Create a new databank. `name` and `scope` are required. `scope_id` is required for `character` and `chat` scopes. |
| `update(databankId, input)` | `Promise<DatabankDTO>` | Update a databank. `name`, `description`, and `enabled` are optional. Scope cannot be changed after creation. |
| `delete(databankId)` | `Promise<boolean>` | Delete a databank and all of its documents/chunks. Associated vectors are removed first. Returns `true` if deleted. |

### Documents

| Method | Returns | Description |
|---|---|---|
| `documents.list(databankId, options?)` | `Promise<{ data: DatabankDocumentDTO[], total: number }>` | List documents in a databank. Options: `{ limit?, offset? }`. Defaults: limit 50, max 200. |
| `documents.get(documentId)` | `Promise<DatabankDocumentDTO \| null>` | Get a document by ID. Returns `null` if not found. |
| `documents.create(databankId, input)` | `Promise<DatabankDocumentDTO>` | Upload a new document into the databank. Processing starts asynchronously after creation. |
| `documents.update(documentId, input)` | `Promise<DatabankDocumentDTO>` | Rename a document. Updates the human-readable name and the derived slug. |
| `documents.delete(documentId)` | `Promise<boolean>` | Delete a document, its parsed chunks, and its vectors. Returns `true` if deleted. |
| `documents.getContent(documentId)` | `Promise<{ content: string } \| null>` | Get the parsed, stitched document text. Returns `null` if the document does not exist or has not finished processing yet. |
| `documents.reprocess(documentId)` | `Promise<{ success: true, status: "processing" }>` | Reset a document to `pending`, delete its old vectors, and queue it for reprocessing. |

## DatabankDTO

```ts
{
  id: string
  name: string
  description: string
  scope: 'global' | 'character' | 'chat'
  scope_id: string | null
  enabled: boolean
  metadata: Record<string, unknown>
  document_count?: number
  created_at: number   // unix epoch seconds
  updated_at: number
}
```

## DatabankCreateDTO

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Databank name |
| `description` | `string` | No | Human-readable description |
| `scope` | `'global' \| 'character' \| 'chat'` | Yes | Activation scope |
| `scope_id` | `string \| null` | Conditionally | Required for `character` and `chat` scopes; omit for `global` |

## DatabankUpdateDTO

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Rename the databank |
| `description` | `string` | Update the description |
| `enabled` | `boolean` | Enable or disable the databank without deleting it |

!!! note "List filter naming"
    `spindle.databanks.list()` uses `scopeId` in its options object, while `DatabankCreateDTO` uses `scope_id` to match the serialized DTO shape.

---

## Documents

Documents live under `spindle.databanks.documents`. Each uploaded file is stored on disk, parsed into plain text, chunked, and then vectorized asynchronously.

### Document Lifecycle

Document status moves through these states:

- `pending` — uploaded and waiting for processing
- `processing` — currently being parsed/chunked/vectorized
- `ready` — parsed content and chunks are available
- `error` — processing failed; see `error_message`

The `create()` call returns immediately after the database row is created. Use `documents.get()` to poll `status`, or call `documents.getContent()` once the document reaches `ready`.

### Supported Formats

Text-oriented uploads only. The current supported extensions are:

```text
.txt, .md, .markdown, .csv, .tsv, .json, .xml, .html, .htm, .yaml, .yml, .log, .rst, .rtf
```

Uploads larger than 10 MB are rejected.

### DatabankDocumentDTO

```ts
{
  id: string
  databank_id: string
  name: string
  slug: string
  mime_type: string
  file_size: number
  content_hash: string
  total_chunks: number
  status: 'pending' | 'processing' | 'ready' | 'error'
  error_message: string | null
  metadata: Record<string, unknown>
  created_at: number   // unix epoch seconds
  updated_at: number
}
```

### DatabankDocumentCreateDTO

| Field | Type | Required | Description |
|---|---|---|---|
| `data` | `Uint8Array` | Yes | Raw file bytes |
| `filename` | `string` | Yes | Original filename, including extension |
| `mime_type` | `string` | No | MIME type to record on the document |
| `name` | `string` | No | Display name override. Defaults to `filename` without the extension |

### DatabankDocumentUpdateDTO

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | New display name |

### Parsed Content

`documents.getContent()` returns the parsed plain-text content assembled from the document's stored chunks:

```ts
const parsed = await spindle.databanks.documents.getContent(doc.id)
if (!parsed) {
  spindle.log.warn('Document is still processing, missing, or failed before chunks were created')
} else {
  spindle.log.info(parsed.content)
}
```

### Reprocessing

Reprocessing is useful after replacing your own parsing assumptions, changing embeddings configuration, or recovering from a prior ingestion failure:

```ts
await spindle.databanks.documents.reprocess(doc.id)
```

This deletes the document's existing vectors, resets the status to `pending`, and queues the full ingestion pipeline again.

## Scope and Activation

Databank scope controls where Lumiverse treats a databank as active during retrieval:

- `global` — available everywhere for that user
- `character` — active when the matching character is in context
- `chat` — active when the matching chat is in context

This API manages databank records and documents directly. If your extension also wants to link databanks through character extensions or chat metadata, that linkage still lives on the `characters` and `chats` surfaces.

!!! note
    For user-scoped extensions, the user context is inferred automatically. For operator-scoped extensions, pass `userId` to scope calls to a specific user. Databanks and their documents are always scoped to a single user.
