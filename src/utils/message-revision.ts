/** Returns the stored positive integer revision, or null when unavailable. */
export function readMessageRevision(row: object | null | undefined): number | null {
  if (!row || !("revision" in row)) return null;
  const value = row.revision;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}
