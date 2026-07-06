# Images

!!! warning "Permission required: `images`"

Read, upload, and delete image/video assets stored in Lumiverse's shared asset system. Spindle automatically tags uploads with the current extension identifier, and the list/get APIs can filter by extension ownership, character ownership, chat ownership, and requested resolution specificity.

## Usage

```ts
// List all assets visible to the user
const { data, total } = await spindle.images.list({ limit: 20, offset: 0 })

// List only assets created by this extension, but return small thumbnail URLs
const ownedThumbs = await spindle.images.list({
  onlyOwned: true,
  specificity: 'sm',
})

// Further narrow to a single character or chat
const characterImages = await spindle.images.list({
  onlyOwned: true,
  characterId: 'char-id',
  specificity: 'lg',
})

const chatImages = await spindle.images.list({
  onlyOwned: true,
  chatId: 'chat-id',
})

// Get a single asset DTO
const image = await spindle.images.get('image-id', {
  onlyOwned: true,
  specificity: 'sm',
})

// Upload raw bytes; the current extension is recorded automatically.
const uploaded = await spindle.images.upload({
  data: pngBytes,
  filename: 'cover.png',
  mime_type: 'image/png',
  owner_character_id: 'char-id',
  owner_chat_id: 'chat-id',
})

// Persist raw video bytes, including output from spindle.media.*, back into
// the shared asset store.
const storedVideo = await spindle.images.upload({
  data: videoBytes,
  filename: 'clip.mp4',
  mime_type: 'video/mp4',
  transcode_video_codec: 'h264',
  sidecar_video_codecs: ['hevc'],
})

// Batch upload — one IPC + host-side concurrency pool replaces N round-trips
const results = await spindle.images.uploadMany([
  { data: bytes1, filename: 'a.png', mime_type: 'image/png' },
  { data: bytes2, filename: 'b.png', mime_type: 'image/png' },
])
// Returns Array<{ id?: string; error?: string }> — per-item failures don't throw the batch

// Upload a data URL with ownership tags
const generated = await spindle.images.uploadFromDataUrl(dataUrl, {
  originalFilename: 'generated.png',
  owner_character_id: 'char-id',
  owner_chat_id: 'chat-id',
})

// Delete an asset
await spindle.images.delete(uploaded.id)

// Bulk delete by ID
const deletedCount = await spindle.images.deleteMany(imageIds)
```

## Methods

| Method | Returns | Description |
|---|---|---|
| `list(options?)` | `Promise<{ data: ImageDTO[], total: number }>` | List stored assets. Options: `{ limit?, offset?, specificity?, onlyOwned?, characterId?, chatId? }`. Defaults: limit 50, max 200. |
| `get(imageId, options?)` | `Promise<ImageDTO \| null>` | Get a single asset DTO. Options: `{ specificity?, onlyOwned?, characterId?, chatId? }`. Returns `null` when the asset is missing or excluded by the ownership filters. |
| `upload(input)` | `Promise<ImageDTO>` | Upload raw image or video bytes. The host automatically tags the stored asset with the current extension identifier. |
| `uploadMany(items, options?)` | `Promise<Array<{ id?: string; error?: string }>>` | Batch upload multiple assets in a single IPC call. Per-item failures captured as `{error}` rather than throwing. Options: `{ userId?, concurrency? }` (concurrency capped at 32, default 16). |
| `uploadFromDataUrl(dataUrl, options?)` | `Promise<ImageDTO>` | Upload a base64 image data URL. The host automatically tags the stored asset with the current extension identifier. |
| `delete(imageId)` | `Promise<boolean>` | Delete an asset by ID. Returns `true` when deleted. Emits `IMAGE_DELETED`. |
| `deleteMany(imageIds, options?)` | `Promise<number>` | Bulk delete by ID. Returns the number of assets deleted (missing IDs are skipped). Does not emit per-image `IMAGE_DELETED` events. Options: `{ userId? }`. |

## ImageListOptionsDTO

| Field | Type | Description |
|---|---|---|
| `limit` | `number` | Page size. Default 50, max 200. |
| `offset` | `number` | Pagination offset. |
| `specificity` | `'full' \| 'sm' \| 'lg'` | Which asset URL size should be returned in each DTO. `'full'` is the original asset URL, `'sm'` and `'lg'` return thumbnail URLs. |
| `onlyOwned` | `boolean` | Restrict results to assets created by the current extension. |
| `characterId` | `string` | Restrict results to assets tagged to a specific character. |
| `chatId` | `string` | Restrict results to assets tagged to a specific chat. |
| `userId` | `string` | **Required for operator-scoped extensions.** |

## ImageGetOptionsDTO

Same ownership and `specificity` fields as `ImageListOptionsDTO`, minus pagination.

## ImageDTO

```ts
{
  id: string
  original_filename: string
  mime_type: string                  // image/* or video/*
  width: number | null
  height: number | null
  has_thumbnail: boolean
  url: string                         // authenticated relative URL for this specificity
  specificity: 'full' | 'sm' | 'lg'   // size encoded into url
  owner_extension_identifier: string | null
  owner_character_id: string | null
  owner_chat_id: string | null
  created_at: number                  // unix epoch seconds
}
```

## ImageUploadDTO

| Field | Type | Required | Description |
|---|---|---|---|
| `data` | `Uint8Array` | Yes | Raw image or video bytes. |
| `filename` | `string` | No | Original filename to store with the asset. |
| `mime_type` | `string` | No | MIME type. Defaults to `image/png` when omitted and not inferable. |
| `owner_character_id` | `string` | No | Optional character ownership tag stored with the asset. |
| `owner_chat_id` | `string` | No | Optional chat ownership tag stored with the asset. |
| `strip_audio` | `boolean` | No | For video uploads, strip any audio tracks from the stored output when possible. |
| `transcode_video_codec` | `'h264' \| 'hevc'` | No | For video uploads, transcode the primary stored asset to this codec. |
| `sidecar_video_codecs` | `Array<'h264' \| 'hevc'>` | No | Generate additional stored video variants alongside the primary asset. |

## ImageUploadFromDataUrlOptionsDTO

| Field | Type | Description |
|---|---|---|
| `originalFilename` | `string` | Optional filename to persist with the asset. |
| `owner_character_id` | `string` | Optional character ownership tag stored with the asset. |
| `owner_chat_id` | `string` | Optional chat ownership tag stored with the asset. |
| `userId` | `string` | **Required for operator-scoped extensions.** |

## Ownership Model

- Every upload made through `spindle.images.upload()` or `spindle.images.uploadFromDataUrl()` is automatically tagged with `owner_extension_identifier = <current extension id>`.
- `onlyOwned: true` applies that extension filter at read time, which avoids scanning the full user asset set when an extension only cares about its own uploads.
- `characterId` and `chatId` are additive filters. Combine them with `onlyOwned: true` when you want "only my extension's assets for this character/chat".

## Specificity And URLs

- `specificity: 'full'` returns `/api/v1/images/{id}`.
- `specificity: 'sm'` returns `/api/v1/images/{id}?size=sm`.
- `specificity: 'lg'` returns `/api/v1/images/{id}?size=lg`.
- These URLs are authenticated image endpoints. Use `ImageDTO.url` directly instead of rebuilding the path yourself.

## Notes

- `spindle.images.get()` returns metadata plus a URL, not the binary asset bytes themselves.
- Thumbnail generation is supported automatically. `has_thumbnail` tells you whether thumbnails are available or can be lazily generated. `uploadMany` defers thumbnail (and width/height) generation to a background job for throughput; the underlying row populates these fields asynchronously after the call returns.
- Video assets stored here can be used as `spindle.media` inputs via `source: { kind: "image", image_id }`. Despite the source name, that media source kind accepts still images and video assets from this store.
- Generated images persisted through `spindle.imageGen.generate()` also participate in this ownership model when `owner_character_id` or `owner_chat_id` are supplied.

!!! note
    For user-scoped extensions, the user context is inferred automatically. For operator-scoped extensions, pass `userId` when working on behalf of a specific user.
