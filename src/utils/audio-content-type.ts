/**
 * Derive the HTTP Content-Type for a TTS audio stream from the client's
 * requested output format. Falls back to audio/mpeg for mp3 and any
 * unrecognised value.
 */
export function contentTypeForFormat(format?: string | null): string {
  switch (format) {
    case "wav":
      return "audio/wav";
    case "raw":
    case "pcm":
      return "audio/pcm";
    case "mp3":
    default:
      return "audio/mpeg";
  }
}
