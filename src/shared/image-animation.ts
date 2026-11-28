export const THUMBNAIL_VERSION = 3;

export type ImageAnimationType = "apng" | "webp";

/** Inspect container records, rather than extensions or arbitrary metadata text. */
export function imageAnimationType(bytes: Uint8Array): ImageAnimationType | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number, text: string) =>
    offset + text.length <= bytes.length && [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if (bytes.length >= 21 && tag(0, "RIFF") && tag(8, "WEBP") && tag(12, "VP8X")) {
    return bytes[20] & 2 ? "webp" : null;
  }
  if (bytes.length < 8 || ![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) return null;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) return null;
    if (tag(offset + 4, "acTL")) return length === 8 && view.getUint32(offset + 8) > 0 ? "apng" : null;
    if (tag(offset + 4, "IDAT") || tag(offset + 4, "IEND")) return null;
    offset += length + 12;
  }
  return null;
}
