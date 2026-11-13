/** SQLite reports cumulative progress for the current WAL, not pages copied
 * during this call. PASSIVE can return busy=0 with pages still pinned by readers.
 */
export function formatCheckpointDiagnostics(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const { busy, log, checkpointed } = result as Record<string, unknown>;
  if (typeof busy !== "number" || typeof log !== "number" || typeof checkpointed !== "number") return "";
  const remaining = log < 0 || checkpointed < 0 ? "unknown" : Math.max(0, log - checkpointed);
  return ` mode=PASSIVE busy=${busy} walPages=${log} checkpointedPages=${checkpointed} remainingPages=${remaining}`;
}
