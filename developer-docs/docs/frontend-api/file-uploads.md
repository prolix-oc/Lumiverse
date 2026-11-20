# File Uploads

For large imports, use the [resumable upload endpoint](../backend-api/uploads.md), then pass its upload id to the backend [file and archive APIs](../backend-api/file-transfers.md).

## `ctx.files.download(fileId)`

Download a completed file staged by your backend with `spindle.files` or `spindle.archives`. Call this from a download button after receiving the ready file id. It starts a native browser/WebView attachment download with the current user's session cookie, keeping archive bytes out of frontend JavaScript memory.

```ts
downloadButton.addEventListener('click', () => ctx.files.download(readyFileId))
```

The backend must retain the staged file while it is offered for download. Ownership is verified by the host; files from other users or extensions are unavailable. The method starts a download and returns `void`; completion is handled by the browser/WebView.

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
