/**
 * Some CDNs serve fonts and audio with a generic binary content type (cdnjs
 * serves .woff2 as application/octet-stream). The sandbox media proxy accepts
 * these for fonts and audio only; the magic-byte check still has to recognize
 * the file.
 */
export function isGenericBinaryContentType(contentType: string): boolean {
  const base = contentType.toLowerCase().split(";")[0].trim();
  return base === "application/octet-stream" || base === "binary/octet-stream";
}
