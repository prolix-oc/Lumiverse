# File Uploads

## `ctx.uploads.pickFile(options?)`

Open the browser's native file picker and return the selected file(s) as typed arrays. Useful for importing configuration files, images, or other user data into your extension.

```ts
const files = await ctx.uploads.pickFile({
  accept: ['.json', 'application/json'],  // file type filters
  multiple: false,                         // allow multiple selection
  maxSizeBytes: 1024 * 1024,              // 1 MB limit
})

for (const file of files) {
  console.log(file.name)      // "config.json"
  console.log(file.mimeType)  // "application/json"
  console.log(file.sizeBytes) // 1234
  // file.bytes is a Uint8Array of the file contents
  const text = new TextDecoder().decode(file.bytes)
}
```

## Options

| Field | Type | Description |
|---|---|---|
| `accept` | `string[]` | Optional. File type filters (extensions or MIME types) |
| `multiple` | `boolean` | Optional. Allow selecting multiple files. Default: `false` |
| `maxSizeBytes` | `number` | Optional. Maximum file size in bytes. Throws if a selected file exceeds this limit |

## SpindleUploadFile (returned)

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Original file name |
| `mimeType` | `string` | MIME type (falls back to `"application/octet-stream"`) |
| `sizeBytes` | `number` | File size in bytes |
| `bytes` | `Uint8Array` | Raw file contents |
