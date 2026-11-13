export const OMITTED_CAPTURE_MEDIA = "[CAPTURE MEDIA OMITTED]";

/** Preserve inspectable prompt/response text without retaining captured media. */
export function omitCaptureMedia(value: unknown): unknown {
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 100) throw new Error("Capture history nesting limit exceeded");
    if (typeof item === "string") {
      // Error messages and tool arguments may embed JSON or inline data URLs.
      if (/^\s*[\[{]/.test(item)) {
        let parsed: unknown;
        try { parsed = JSON.parse(item); } catch { /* Ordinary text. */ }
        if (parsed !== undefined) return JSON.stringify(visit(parsed, depth + 1));
      }
      return item
        .replace(/data:(?:image|video|audio)\/[^\s;,"<>]+(?:;[^\s,"<>]*)?,[a-z0-9+/_=-]+/gi, OMITTED_CAPTURE_MEDIA)
        .replace(/[a-z0-9+/_=-]{1024,}/gi, OMITTED_CAPTURE_MEDIA);
    }
    if (Array.isArray(item)) return item.map((nested) => visit(nested, depth + 1));
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item).map(([key, nested]) => {
      const field = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (["imageurl", "videourl", "audiourl"].includes(field)) {
        return [key, typeof nested === "string" ? OMITTED_CAPTURE_MEDIA : { url: OMITTED_CAPTURE_MEDIA }];
      }
      if (["fileuri", "fileurl", "filedata", "b64json", "inputaudio", "bytes"].includes(field)
        || (["data", "image", "video", "audio"].includes(field) && (typeof nested === "string"
          || Array.isArray(nested) && nested.every((part) => typeof part === "number")))) {
        return [key, OMITTED_CAPTURE_MEDIA];
      }
      return [key, visit(nested, depth + 1)];
    }));
  };
  return visit(value, 0);
}
