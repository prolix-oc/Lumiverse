/**
 * Parse a single-range HTTP `Range: bytes=...` header against a known file
 * size. Returns the resolved {start, end} (inclusive, zero-indexed), or
 * "invalid" for syntactically wrong / out-of-bounds requests (caller should
 * 416), or null when the header is absent / malformed in a way we'd rather
 * just serve the full file for (e.g. multipart ranges).
 *
 * Three forms accepted:
 *   bytes=START-END   closed range
 *   bytes=START-      from START to end of file
 *   bytes=-N          last N bytes (suffix range)
 */
export function parseRangeHeader(
  header: string | undefined | null,
  totalSize: number,
): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null; // multipart or malformed — fall back to 200

  const startStr = match[1];
  const endStr = match[2];

  let start: number;
  let end: number;

  if (startStr === "" && endStr !== "") {
    // Suffix range: last N bytes.
    const suffix = Number.parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else if (startStr !== "") {
    start = Number.parseInt(startStr, 10);
    end = endStr !== "" ? Number.parseInt(endStr, 10) : totalSize - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "invalid";
  } else {
    return "invalid";
  }

  // Clamp end so callers don't have to special-case the last byte.
  if (end >= totalSize) end = totalSize - 1;

  if (start > end || start < 0 || start >= totalSize) return "invalid";

  return { start, end };
}
