# Uploads

Receive large files from your extension's frontend without the WebSocket frame-size limits, then read the staged upload in the backend worker by id.

The browser streams the file to a resumable [tus](https://tus.io) endpoint on the host, which writes it straight to disk. The worker can pull the complete bytes with `spindle.uploads.get(uploadId)` or read bounded pieces with `spindle.uploads.readChunk(uploadId, offset)`. This avoids base64-over-WebSocket inflation and the 4 MB `SPINDLE_BACKEND_MSG` cap.

If your next step is a [`spindle.media.*`](media.md) transform, you usually do **not** need to call `spindle.uploads.get()` first. Pass `{ kind: "upload", upload_id }` directly to the media API and let the host read the staged file in place.

No permission is required. Each upload is scoped to the extension that created it and the user who was signed in.

## Flow

1. The frontend uploads the file to `/api/v1/spindle-uploads` with the tus protocol, tagging it with your extension identifier.
2. On success the frontend sends your own backend a small message carrying the returned `uploadId`.
3. The worker calls `spindle.uploads.get(uploadId)` or repeatedly calls `spindle.uploads.readChunk(uploadId, offset)`, then deletes the upload.

### Frontend

Use any tus 1.0.0 client. The example uses [tus-js-client](https://github.com/tus/tus-js-client).

```ts
import * as tus from 'tus-js-client'

const upload = new tus.Upload(file, {
  endpoint: '/api/v1/spindle-uploads',
  chunkSize: 16 * 1024 * 1024,
  retryDelays: [0, 1000, 3000, 5000, 10000],
  removeFingerprintOnSuccess: true,
  metadata: { filename: file.name, extension: 'my_extension' },
  onProgress: (sent, total) => {
    ctx.log.info(`upload ${Math.round((sent / total) * 100)}%`)
  },
  onSuccess: () => {
    const uploadId = (upload.url ?? '').split('/').filter(Boolean).pop()
    ctx.sendToBackend({ type: 'import_file', uploadId })
  },
})
upload.start()
```

The `extension` metadata value must be your manifest identifier. The host stores it so only your worker can read the upload back. `filename` is optional and is returned to the worker.

Uploads default to the existing 1 GiB limit. To opt into the 100 GiB limit, include `spindle_read_mode: 'chunked'` in the tus metadata and consume the upload with `spindle.uploads.readChunk()`.

### Backend

```ts
spindle.onFrontendMessage(async (msg, userId) => {
  if (msg.type !== 'import_file') return

  const file = await spindle.uploads.get(msg.uploadId, userId)
  if (!file) {
    spindle.log.warn(`upload ${msg.uploadId} not found or expired`)
    return
  }
  try {
    spindle.log.info(`got ${file.size} bytes (${file.fileName})`)
    await processBytes(file.data)
  } finally {
    await spindle.uploads.delete(msg.uploadId, userId)
  }
})
```

## Methods

### `spindle.uploads.get(uploadId, userId?)`

Read a completed upload's bytes. Returns `null` if the upload is missing, expired, or was not created by this extension for this user.

**Returns:** `Promise<SpindleUploadDTO | null>`

### `spindle.uploads.readChunk(uploadId, offset, userId?)`

Read at most 16 MiB from a completed upload, beginning at `offset`. Returns `null` if the upload is missing, expired, or belongs to another extension or user. Invalid offsets and incomplete uploads reject the request.

Advance the next request by `result.data.byteLength` until `result.eof` is true. Each successful read refreshes the upload's inactivity timeout.

**Returns:** `Promise<SpindleUploadChunkDTO | null>`

### `spindle.uploads.delete(uploadId, userId?)`

Delete a staged upload and its on-disk file. Returns `false` if it was already gone. Call this once you have consumed the bytes so the file does not sit on disk until its TTL expires.

**Returns:** `Promise<boolean>`

## Result Shape

```ts
type SpindleUploadDTO = {
  fileName: string
  size: number
  data: Uint8Array
}

type SpindleUploadChunkDTO = {
  fileName: string
  size: number
  offset: number
  data: Uint8Array
  eof: boolean
}
```

| Field | Type | Description |
|---|---|---|
| `fileName` | `string` | The `filename` metadata value supplied at upload time |
| `size` | `number` | Byte length of `data` |
| `data` | `Uint8Array` | The assembled file bytes |

## HTTP Endpoint

The endpoint implements the tus 1.0.0 core protocol plus the `creation` extension. Authentication is the standard session cookie, so send credentials with the request.

| Method | Path | Purpose |
|---|---|---|
| `OPTIONS` | `/api/v1/spindle-uploads` | Report `Tus-Version`, `Tus-Extension`, and `Tus-Max-Size` |
| `POST` | `/api/v1/spindle-uploads` | Create an upload from `Upload-Length` and `Upload-Metadata`, returns `Location` |
| `HEAD` | `/api/v1/spindle-uploads/:id` | Report the current `Upload-Offset` for resuming |
| `PATCH` | `/api/v1/spindle-uploads/:id` | Append bytes at `Upload-Offset` |

`Upload-Metadata` is a comma-separated list of `key base64(value)` pairs. The `extension` key is required. The `filename` key is optional. Set `spindle_read_mode` to `chunked` to opt into large uploads.

## Notes

- Uploads default to a 1 GiB maximum. `spindle_read_mode=chunked` raises the individual limit to 100 GiB. Staged uploads currently have no aggregate storage quota or free-space reservation.
- Uploads expire after 30 minutes of inactivity and are swept from disk. Read and delete promptly.
- `get` returns the full file as a `Uint8Array`, so size your processing for the byte length you expect.
- `readChunk` never returns more than 16 MiB and does not load the complete staged file into host or worker memory.
- The upload is bound to the extension identifier in `Upload-Metadata` and the signed-in user. Another extension cannot read it even with the id.

!!! note
    For user-scoped extensions the user context is inferred automatically. For operator-scoped extensions pass `userId` so the host can confirm the upload belongs to that user.
