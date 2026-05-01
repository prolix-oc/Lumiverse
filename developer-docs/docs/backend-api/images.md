# Images

!!! warning "Permission required: `images`"

Read, upload, and delete images stored in Lumiverse's image system. Spindle automatically tags uploads with the current extension identifier, and the list/get APIs can now filter by extension ownership, character ownership, chat ownership, and requested resolution specificity.

## Usage

```ts
// List all images visible to the user
const { data, total } = await spindle.images.list({ limit: 20, offset: 0 })

// List only images created by this extension, but return small thumbnail URLs
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

// Get a single image DTO
const image = await spindle.images.get('image-id', {
  onlyOwned: true,
  specificity: 'sm',
})

// Upload raw bytes; the current extension is recorded automatically
const uploaded = await spindle.images.upload({
  data: pngBytes,
  filename: 'cover.png',
  mime_type: 'image/png',
  owner_character_id: 'char-id',
  owner_chat_id: 'chat-id',
})

// Upload a data URL with ownership tags
const generated = await spindle.images.uploadFromDataUrl(dataUrl, {
  originalFilename: 'generated.png',
  owner_character_id: 'char-id',
  owner_chat_id: 'chat-id',
})

// Delete an image
await spindle.images.delete(uploaded.id)
```

## Methods

| Method | Returns | Description |
|---|---|---|
| `list(options?)` | `Promise<{ data: ImageDTO[], total: number }>` | List images. Options: `{ limit?, offset?, specificity?, onlyOwned?, characterId?, chatId? }`. Defaults: limit 50, max 200. |
| `get(imageId, options?)` | `Promise<ImageDTO \| null>` | Get a single image DTO. Options: `{ specificity?, onlyOwned?, characterId?, chatId? }`. Returns `null` when the image is missing or excluded by the ownership filters. |
| `upload(input)` | `Promise<ImageDTO>` | Upload raw image bytes. The host automatically tags the image with the current extension identifier. |
| `uploadFromDataUrl(dataUrl, options?)` | `Promise<ImageDTO>` | Upload a base64 image data URL. The host automatically tags the image with the current extension identifier. |
| `delete(imageId)` | `Promise<boolean>` | Delete an image by ID. Returns `true` when deleted. |

## ImageListOptionsDTO

| Field | Type | Description |
|---|---|---|
| `limit` | `number` | Page size. Default 50, max 200. |
| `offset` | `number` | Pagination offset. |
| `specificity` | `'full' \| 'sm' \| 'lg'` | Which image URL size should be returned in each DTO. `'full'` is the original image URL, `'sm'` and `'lg'` return thumbnail URLs. |
| `onlyOwned` | `boolean` | Restrict results to images created by the current extension. |
| `characterId` | `string` | Restrict results to images tagged to a specific character. |
| `chatId` | `string` | Restrict results to images tagged to a specific chat. |
| `userId` | `string` | **Required for operator-scoped extensions.** |

## ImageGetOptionsDTO

Same ownership and `specificity` fields as `ImageListOptionsDTO`, minus pagination.

## ImageDTO

```ts
{
  id: string
  original_filename: string
  mime_type: string
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
| `data` | `Uint8Array` | Yes | Raw image bytes. |
| `filename` | `string` | No | Original filename to store with the image. |
| `mime_type` | `string` | No | MIME type. Defaults to `image/png` when omitted. |
| `owner_character_id` | `string` | No | Optional character ownership tag stored with the image. |
| `owner_chat_id` | `string` | No | Optional chat ownership tag stored with the image. |

## ImageUploadFromDataUrlOptionsDTO

| Field | Type | Description |
|---|---|---|
| `originalFilename` | `string` | Optional filename to persist with the image. |
| `owner_character_id` | `string` | Optional character ownership tag stored with the image. |
| `owner_chat_id` | `string` | Optional chat ownership tag stored with the image. |
| `userId` | `string` | **Required for operator-scoped extensions.** |

## Ownership Model

- Every upload made through `spindle.images.upload()` or `spindle.images.uploadFromDataUrl()` is automatically tagged with `owner_extension_identifier = <current extension id>`.
- `onlyOwned: true` applies that extension filter at read time, which avoids scanning the full user image set when an extension only cares about its own images.
- `characterId` and `chatId` are additive filters. Combine them with `onlyOwned: true` when you want "only my extension's images for this character/chat".

## Specificity And URLs

- `specificity: 'full'` returns `/api/v1/images/{id}`.
- `specificity: 'sm'` returns `/api/v1/images/{id}?size=sm`.
- `specificity: 'lg'` returns `/api/v1/images/{id}?size=lg`.
- These URLs are authenticated image endpoints. Use `ImageDTO.url` directly instead of rebuilding the path yourself.

## Notes

- `spindle.images.get()` returns metadata plus a URL, not the binary image bytes themselves.
- Thumbnail generation is supported automatically. `has_thumbnail` tells you whether thumbnails are available or can be lazily generated.
- Generated images persisted through `spindle.imageGen.generate()` also participate in this ownership model when `owner_character_id` or `owner_chat_id` are supplied.

!!! note
    For user-scoped extensions, the user context is inferred automatically. For operator-scoped extensions, pass `userId` when working on behalf of a specific user.
