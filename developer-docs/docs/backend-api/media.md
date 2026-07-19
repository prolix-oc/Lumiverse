# Media

!!! warning "Permission required: `media`"

Run host-side audio/video transforms through Lumiverse's FFmpeg-backed media pipeline. Every `spindle.media.*` call returns transformed bytes plus metadata; outputs are **not** persisted automatically.

Use this API when you need to:

- convert audio between container/codecs
- convert or fully transcode video
- strip or replace a video's audio track
- compose a simple video clip from a still image plus audio

## Usage

```ts
// Convert a staged frontend upload straight to MP3 without pulling bytes
// through the worker first.
const mp3 = await spindle.media.convertAudio({
  source: { kind: 'upload', upload_id: uploadId },
  output_format: 'mp3',
  bitrate_kbps: 192,
  filename: 'voice-note.mp3',
  userId,
})
await spindle.storage.writeBinary(`exports/${mp3.filename}`, mp3.data)

// Replace a stored video's audio track with an existing Lumiverse audio asset.
const remuxed = await spindle.media.addAudioToVideo({
  video: { kind: 'image', image_id: videoAssetId },
  audio: { kind: 'audio', audio_id: narrationId },
  output_format: 'mp4',
  video_codec: 'copy',
  audio_codec: 'aac',
  replace_existing_audio: true,
  shortest: true,
  userId,
})

// Turn cover art + audio into a simple 720p clip.
const clip = await spindle.media.createVideoFromImageAndAudio({
  image: { kind: 'image', image_id: posterId },
  audio: { kind: 'upload', upload_id: songUploadId },
  output_format: 'mp4',
  video_codec: 'h264',
  width: 1280,
  height: 720,
  fps: 30,
  fit_mode: 'contain',
  background_color: '#000000',
  userId,
})
```

## Methods

| Method | Returns | Description |
|---|---|---|
| `convertAudio(input)` | `Promise<MediaTransformResultDTO>` | Convert any source with an audio stream to a target container/codec and optionally resample or change channel count. |
| `convertVideo(input)` | `Promise<MediaTransformResultDTO>` | Convert a video source to another container using host defaults for the target format. |
| `transcodeVideo(input)` | `Promise<MediaTransformResultDTO>` | Full video/audio transcoding with codec, bitrate, CRF, size, fps, pixel-format, and faststart controls. |
| `removeAudioFromVideo(input)` | `Promise<MediaTransformResultDTO>` | Drop the audio track from a video. |
| `addAudioToVideo(input)` | `Promise<MediaTransformResultDTO>` | Mux an audio source into a video, optionally replacing the existing track or offsetting the new track. |
| `createVideoFromImageAndAudio(input)` | `Promise<MediaTransformResultDTO>` | Build a simple video from a still image timed to an audio source. |

## Media Sources

Every method accepts one or more `MediaSourceDTO` values:

| Kind | Shape | When to use it |
|---|---|---|
| `inline` | `{ kind: "inline", data, filename?, mime_type? }` | You already have the bytes in memory and they are reasonably small. |
| `upload` | `{ kind: "upload", upload_id, filename?, mime_type? }` | Best for large frontend uploads staged through [Uploads](uploads.md). The host reads the file directly from disk. |
| `image` | `{ kind: "image", image_id }` | A stored asset from [Images](images.md). Despite the name, this can point at either a still image or a video upload. |
| `audio` | `{ kind: "audio", audio_id }` | An audio asset already stored in Lumiverse's audio library. |

Video-specific operations validate that the resolved source actually looks like video. `createVideoFromImageAndAudio()` similarly validates that its `image` input looks like an image.

## Formats And Codecs

- `MediaAudioFormatDTO`: `mp3`, `wav`, `ogg`, `aac`, `flac`, `m4a`, `webm`
- `MediaVideoFormatDTO`: `mp4`, `webm`, `mov`, `mkv`
- `MediaVideoCodecDTO`: `h264`, `hevc`, `vp9`, `av1`, `copy`
- `MediaAudioCodecDTO`: `aac`, `mp3`, `opus`, `vorbis`, `flac`, `pcm_s16le`, `copy`
- `MediaFitModeDTO`: `contain`, `cover`, `stretch`

`transcodeVideo()` additionally accepts `audio_codec: "none"` to strip audio entirely. `createVideoFromImageAndAudio()` does not allow `video_codec: "copy"` because it is creating a new video stream from a still image.

## Operation Inputs

### `convertAudio(input)`

```ts
{
  source: MediaSourceDTO
  output_format: 'mp3' | 'wav' | 'ogg' | 'aac' | 'flac' | 'm4a' | 'webm'
  audio_codec?: 'aac' | 'mp3' | 'opus' | 'vorbis' | 'flac' | 'pcm_s16le' | 'copy'
  bitrate_kbps?: number
  sample_rate?: number
  channels?: number
  filename?: string
  userId?: string
}
```

### `convertVideo(input)`

```ts
{
  source: MediaSourceDTO
  output_format: 'mp4' | 'webm' | 'mov' | 'mkv'
  filename?: string
  userId?: string
}
```

### `transcodeVideo(input)`

```ts
{
  source: MediaSourceDTO
  output_format?: 'mp4' | 'webm' | 'mov' | 'mkv'
  video_codec?: 'h264' | 'hevc' | 'vp9' | 'av1' | 'copy'
  audio_codec?: 'aac' | 'mp3' | 'opus' | 'vorbis' | 'flac' | 'pcm_s16le' | 'copy' | 'none'
  video_bitrate_kbps?: number
  audio_bitrate_kbps?: number
  crf?: number
  preset?: string
  width?: number
  height?: number
  fps?: number
  pixel_format?: string
  faststart?: boolean
  filename?: string
  userId?: string
}
```

Key notes:

- `audio_codec: "none"` strips audio entirely.
- `crf` and `preset` map straight to encoder quality/speed controls.
- `faststart` is mainly useful for MP4 outputs that should begin streaming sooner.

### `removeAudioFromVideo(input)`

```ts
{
  source: MediaSourceDTO
  output_format?: 'mp4' | 'webm' | 'mov' | 'mkv'
  video_codec?: 'h264' | 'hevc' | 'vp9' | 'av1' | 'copy'
  filename?: string
  userId?: string
}
```

### `addAudioToVideo(input)`

```ts
{
  video: MediaSourceDTO
  audio: MediaSourceDTO
  output_format?: 'mp4' | 'webm' | 'mov' | 'mkv'
  video_codec?: 'h264' | 'hevc' | 'vp9' | 'av1' | 'copy'
  audio_codec?: 'aac' | 'mp3' | 'opus' | 'vorbis' | 'flac' | 'pcm_s16le' | 'copy'
  replace_existing_audio?: boolean
  shortest?: boolean
  audio_start_ms?: number
  filename?: string
  userId?: string
}
```

Key notes:

- `replace_existing_audio` defaults to `true`.
- `shortest` clamps the output duration to the shorter stream.
- `audio_start_ms` inserts a positive delay before the new audio begins.

### `createVideoFromImageAndAudio(input)`

```ts
{
  image: MediaSourceDTO
  audio: MediaSourceDTO
  output_format?: 'mp4' | 'webm' | 'mov' | 'mkv'
  video_codec?: 'h264' | 'hevc' | 'vp9' | 'av1'
  audio_codec?: 'aac' | 'mp3' | 'opus' | 'vorbis' | 'flac' | 'pcm_s16le' | 'copy'
  width?: number
  height?: number
  fps?: number
  fit_mode?: 'contain' | 'cover' | 'stretch'
  background_color?: string
  filename?: string
  userId?: string
}
```

`fit_mode` controls how the still image fills the output frame:

- `contain` preserves the whole image and pads as needed
- `cover` fills the frame by cropping
- `stretch` resizes without preserving aspect ratio

## Result Shape

All methods return `MediaTransformResultDTO`:

```ts
{
  data: Uint8Array
  filename: string
  mime_type: string
  byte_size: number
  duration_ms?: number | null
  width?: number | null
  height?: number | null
}
```

| Field | Type | Description |
|---|---|---|
| `data` | `Uint8Array` | The transformed file bytes. |
| `filename` | `string` | Output filename chosen by the host or overridden by your request. |
| `mime_type` | `string` | MIME type for the transformed output. |
| `byte_size` | `number` | Byte length of `data`. |
| `duration_ms` | `number \| null` | Duration reported by FFmpeg when available. |
| `width` | `number \| null` | Video width when the result is video. |
| `height` | `number \| null` | Video height when the result is video. |

## Notes

- Prefer `kind: "upload"` for large frontend files. It avoids moving the payload through WebSocket or storing duplicate bytes in worker memory.
- Outputs are returned to your worker only. Persist them yourself with `spindle.storage.writeBinary()`, send them to the frontend, or upload video/image outputs back into [Images](images.md).
- Audio outputs are not automatically registered in Lumiverse's audio library.
- All `spindle.media.*` operations require host `ffmpeg`. If the binary is unavailable, the call fails with an explicit error.
- For user-scoped extensions, the user context is inferred automatically. For operator-scoped extensions, pass `userId` so the host can resolve staged uploads and stored assets for the correct user.
