# Uploads

Receive large files from your extension's frontend without the WebSocket frame-size limits, then read the assembled bytes in the backend worker by id.

The browser streams the file to a resumable [tus](https://tus.io) endpoint on the host, which writes it straight to disk. The worker then pulls the bytes with `spindle.uploads.get(uploadId)`. This avoids base64-over-WebSocket inflation, the 4 MB `SPINDLE_BACKEND_MSG` cap, and buffering the whole file in browser memory at send time.

If your next step is a [`spindle.media.*`](media.md) transform, you usually do **not** need to call `spindle.uploads.get()` first. Pass `{ kind: "upload", upload_id }` directly to the media API and let the host read the staged file in place.

No permission is required. Each upload is scoped to the extension that created it and the user who was signed in.

## Flow

1. The frontend uploads the file to `/api/v1/spindle-uploads` with the tus protocol, tagging it with your extension identifier.
2. On success the frontend sends your own backend a small message carrying the returned `uploadId`.
3. The worker calls `spindle.uploads.get(uploadId)`, processes the bytes, then calls `spindle.uploads.delete(uploadId)`.

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

`Upload-Metadata` is a comma-separated list of `key base64(value)` pairs. The `extension` key is required. The `filename` key is optional.

## Notes

- The maximum upload size is 1 GB. `POST` rejects a larger `Upload-Length`, and `PATCH` stops a stream that exceeds the cap.
- Uploads expire after 30 minutes of inactivity and are swept from disk. Read and delete promptly.
- `get` returns the full file as a `Uint8Array`, so size your processing for the byte length you expect.
- The upload is bound to the extension identifier in `Upload-Metadata` and the signed-in user. Another extension cannot read it even with the id.

!!! note
    For user-scoped extensions the user context is inferred automatically. For operator-scoped extensions pass `userId` so the host can confirm the upload belongs to that user.
