const SUPPORTED_PROXY_IMAGE_CONTENT_TYPES = new Set([
  "image/png",
  "image/apng",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-ms-bmp",
]);

function readAscii(data: Uint8Array, start: number, end: number): string {
  return new TextDecoder("ascii", { fatal: false }).decode(data.slice(start, end));
}

function hasAvifBrand(data: Uint8Array): boolean {
  if (data.length < 16) return false;
  if (readAscii(data, 4, 8) !== "ftyp") return false;

  const brands = new Set<string>();
  for (let offset = 8; offset + 4 <= Math.min(data.length, 64); offset += 4) {
    brands.add(readAscii(data, offset, offset + 4));
  }

  return brands.has("avif") || brands.has("avis");
}

export function normalizeImageContentType(contentType: string | null | undefined): string {
  return (contentType || "").split(";")[0]?.trim().toLowerCase() || "";
}

export function isSupportedProxyImageContentType(contentType: string): boolean {
  return SUPPORTED_PROXY_IMAGE_CONTENT_TYPES.has(contentType);
}

export function detectImageContentType(data: Uint8Array): string | null {
  if (data.length < 2) return null;

  if (
    data.length >= 4
    && data[0] === 0x89
    && data[1] === 0x50
    && data[2] === 0x4E
    && data[3] === 0x47
  ) {
    return "image/png";
  }

  if (
    data.length >= 3
    && data[0] === 0xFF
    && data[1] === 0xD8
    && data[2] === 0xFF
  ) {
    return "image/jpeg";
  }

  if (
    data.length >= 4
    && data[0] === 0x47
    && data[1] === 0x49
    && data[2] === 0x46
    && data[3] === 0x38
  ) {
    return "image/gif";
  }

  if (data[0] === 0x42 && data[1] === 0x4D) {
    return "image/bmp";
  }

  if (
    data.length >= 12
    && data[0] === 0x52
    && data[1] === 0x49
    && data[2] === 0x46
    && data[3] === 0x46
    && data[8] === 0x57
    && data[9] === 0x45
    && data[10] === 0x42
    && data[11] === 0x50
  ) {
    return "image/webp";
  }

  if (hasAvifBrand(data)) {
    return "image/avif";
  }

  return null;
}

export function validateImageMagicBytes(data: Uint8Array, contentType: string): boolean {
  const detected = detectImageContentType(data);
  if (!detected) return false;
  if (contentType === "image/apng") return detected === "image/png";
  if (contentType === "image/jpg") return detected === "image/jpeg";
  if (contentType === "image/x-ms-bmp") return detected === "image/bmp";
  return detected === contentType;
}
