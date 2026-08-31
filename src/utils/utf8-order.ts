/**
 * Deterministic byte ordering for canonical identity data.
 *
 * This deliberately avoids locale-sensitive Unicode collation. Callers that
 * need a user-facing display order should continue using their locale-aware
 * comparator instead.
 */
const UTF8_ENCODER = new TextEncoder();

export function compareUtf8(a: string, b: string): number {
  const left = UTF8_ENCODER.encode(a);
  const right = UTF8_ENCODER.encode(b);
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return left.byteLength === right.byteLength ? 0 : left.byteLength < right.byteLength ? -1 : 1;
}
