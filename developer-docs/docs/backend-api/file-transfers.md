# Large files and archives

Use `spindle.files` and `spindle.archives` to download, consume, and export large binary content. The host streams bytes to temporary files on disk. Workers receive file references and bounded chunks; the frontend can hand a file to the browser's native download manager.

`spindle.files.fetch()` requires `cors_proxy`. Local staging and archive operations need no additional permission. Every staged file belongs to one extension installation, one user, and one backend worker lifetime. Operator extensions must supply `userId`; user extensions infer their owner.

## Download and consume an archive

```ts
const archive = await spindle.files.fetch('https://example.com/content.charx', {
  userId,
  fileName: 'content.charx',
  headers: { Authorization: `Bearer ${token}` },
  maxBytes: 2 * 1024 ** 3,
  signal,
})

let extracted = []
try {
  extracted = await spindle.archives.extract({ fileId: archive.fileId }, {
    userId,
    maxDecompressedBytes: 8 * 1024 ** 3,
    signal,
    // Optional: extract only these exact names.
    // entries: ['card.json', 'assets/icon.png'],
  })

  for (const { name, file } of extracted) {
    let offset = 0
    for (;;) {
      const chunk = await spindle.files.readChunk({ fileId: file.fileId }, offset, userId)
      await consumeChunk(name, chunk.data) // Process before requesting another chunk.
      offset += chunk.data.byteLength
      if (chunk.eof) break
    }
  }
} finally {
  for (const { file } of extracted) await spindle.files.delete(file.fileId, userId)
  await spindle.files.delete(archive.fileId, userId)
}
```

Downloads accept any content type, including ZIP, CHARX, JSON, and arbitrary binary assets. They use the same HTTP(S) URL validation, redirect handling, private-network policy, and cross-origin credential stripping as [`spindle.cors`](cors-proxy.md). Non-success HTTP statuses reject. Declared and actual response sizes are capped, including responses without `Content-Length` and decompressed HTTP bodies.

For browser uploads, pass `{ uploadId }` directly to `readChunk`, `archives.extract`, or an archive entry's `source`. The host consumes the completed [tus upload](uploads.md) in place. There is no need to call `spindle.uploads.get()` first.

## Build an export

Produce each entry in bounded chunks, then let the host build the ZIP. For assets already staged by a download or upload, use their references directly.

```ts
const entry = await spindle.files.create({
  userId,
  fileName: 'records.ndjson',
  maxBytes: 1024 ** 3, // A budget; the final length need not be known in advance.
  mimeType: 'application/x-ndjson',
})

try {
  let offset = 0
  // Each piece must be a Uint8Array of at most 1 MiB.
  for await (const piece of generateRecordChunks()) {
    offset = await spindle.files.writeChunk(entry.fileId, offset, piece, userId)
  }
  await spindle.files.finish(entry.fileId, userId)

  const archive = await spindle.archives.create([
    { name: 'records.ndjson', source: { fileId: entry.fileId } },
    { name: 'assets/original.png', source: { uploadId: assetUploadId }, store: true },
  ], { userId, fileName: 'my-export.zip', maxBytes: 5 * 1024 ** 3, signal })

  spindle.sendToFrontend({ type: 'export_ready', fileId: archive.fileId }, userId)
} finally {
  await spindle.files.delete(entry.fileId, userId)
}
```

On the frontend, retain the ready file id and call `ctx.files.download(fileId)` from a download button. The browser/WebView streams an authenticated attachment from disk to its download destination. It never assembles the archive in a JavaScript Blob.

```ts
downloadButton.addEventListener('click', () => ctx.files.download(readyFileId))
```

The backend can also obtain a relative URL with `spindle.files.getDownloadUrl(fileId, userId)`. The URL requires the owning user's session cookie. Keep the exported file until the download has finished or its inactivity timeout expires; deleting it as soon as you send `export_ready` can race the browser's request. Deletion rejects while a download is active.

## Methods

| Method | Result / behavior |
|---|---|
| `files.fetch(url, options?)` | A completed `SpindleFileRef`. Options: `userId`, `fileName` (default `download.bin`), `headers`, `maxBytes` (default 5 GiB), `timeoutMs` (default 30 minutes, maximum 1 hour), `signal`. Performs GET. |
| `files.create({ fileName, size?, maxBytes?, mimeType?, userId? })` | An incomplete reference. Set `size` for an exact final length or `maxBytes` for generated content with an unknown length (default 5 GiB); both reserve disk capacity. Supply only one. Empty files are supported. |
| `files.writeChunk(fileId, offset, data, userId?)` | The next offset. Writes must be sequential and contain 1–1,048,576 bytes. Concurrent writes to the same file reject. |
| `files.finish(fileId, userId?)` | A completed reference after verifying its byte budget and, if supplied, exact `size`. Unused capacity is released. Completed files are immutable. |
| `files.readChunk({ fileId } \| { uploadId }, offset, userId?)` | `{ data: Uint8Array, offset, size, eof }`. Reads at most 1 MiB from a completed file. `size` is the total file length; offsets are safe nonnegative integers. |
| `files.getDownloadUrl(fileId, userId?)` | A relative authenticated download URL for a completed file. |
| `files.delete(fileId, userId?)` | `true` if deleted, `false` for unknown, expired, or foreign ids. Rejects while in use. |
| `archives.create(entries, options?)` | A completed ZIP reference. Entries: `{ name, source: { fileId } \| { uploadId }, store? }`. Options: `userId`, `fileName` (default `export.zip`), `maxBytes` (default 5 GiB), `signal`. `store: true` skips compression for already compressed assets. |
| `archives.extract(source, options?)` | `Array<{ name, file: SpindleFileRef }>`. Options: `userId`, exact `entries` names, `maxDecompressedBytes` (default/maximum 20 GiB), `signal`. Omit `entries` to extract all files; an empty list extracts nothing. Missing selected names reject. Directory records are skipped. |

```ts
interface SpindleFileRef {
  fileId: string
  fileName: string
  size: number
  mimeType: string
}
```

## Bounds and lifecycle

- Files and archive output can be at most 100 GiB each. The aggregate budget for an extension installation and user is also 100 GiB, including in-flight reservations. Choose a smaller `maxBytes` when the expected download or export is small.
- The host checks free disk space before reserving output, keeping 64 MiB of headroom in addition to outstanding reservations. Downloads and archive creation reserve their configured maximum output; extraction reserves the selected entries' declared uncompressed sizes and enforces `maxDecompressedBytes` as an expansion limit. Insufficient space and write failures reject and clean up partial output. Input and output can coexist on disk during archive processing.
- At most 10,000 staged files are allowed per installation/user, and at most 8 file operations can run concurrently per worker. Archive entry names have a combined 1 MiB limit. Consume and delete files in batches when needed.
- ZIP creation uses streaming compression and ZIP64. Extraction reuses the large-bundle import pipeline, supports stored and deflated ZIP/ZIP64 entries, verifies CRC32 and entry sizes, rejects encryption, duplicate targets, and unsafe paths, and limits total expansion. Extracted files are staged separately; no caller-supplied disk path is accepted.
- Staged files expire after 30 minutes of inactivity. Reads and other successful accesses refresh the timeout. Active downloads and archive inputs are pinned until their operation finishes. Backend shutdown cancels producers and removes staged files; an active browser download can finish before its file is removed. Initializing staging cleans up files left by dead host processes.
- `AbortSignal` cancels downloads and archive operations. Cancellation and failed extraction remove partial results. Sources are retained and remain the caller's responsibility to delete. Cancellation rejects with `AbortError`.
- Keep processing bounded in your extension too: request one chunk at a time, await its processing, and avoid concatenating chunks or forwarding bytes through `sendToFrontend`. Only file ids and small metadata need to cross the WebSocket.

The backend and frontend advertise `host.capabilities['file-transfers-v1'] === 1`. Check this when supporting older hosts.

These APIs, DTOs, worker messages, and transfer limits are exported by `lumiverse-spindle-types` starting with `0.6.42`. Import the published types directly:

```ts
import type {
  SpindleFileRef,
  SpindleFileSource,
  SpindleFileChunk,
  SpindleFilesAPI,
  SpindleArchivesAPI,
} from 'lumiverse-spindle-types'
```
