import type { WorldBookEntry, WorldBookVectorIndexStatus } from "../types/world-book";
import type { WorldBookVectorSettings } from "./world-book-vector-settings.service";

type VectorEligibilityEntry = Pick<WorldBookEntry, "vectorized" | "disabled" | "content">;
type VectorSearchReadyEntry = VectorEligibilityEntry & Pick<WorldBookEntry, "vector_index_status">;
type VectorFingerprintEntry = Pick<
  WorldBookEntry,
  "world_book_id" | "content" | "comment" | "key" | "keysecondary" | "vectorized" | "disabled" | "updated_at"
>;

function columnRef(column: string, alias?: string): string {
  return alias ? `${alias}.${column}` : column;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeString(item));
}

export function isWorldBookEntryVectorEligible(entry: VectorEligibilityEntry): boolean {
  return !!entry.vectorized && !entry.disabled && normalizeString(entry.content).trim().length > 0;
}

export function isWorldBookEntryVectorSearchReady(entry: VectorSearchReadyEntry): boolean {
  return isWorldBookEntryVectorEligible(entry) && entry.vector_index_status === "indexed";
}

export function desiredWorldBookVectorIndexStatus(entry: VectorEligibilityEntry): WorldBookVectorIndexStatus {
  return isWorldBookEntryVectorEligible(entry) ? "pending" : "not_enabled";
}

export function worldBookVectorEligibilitySql(alias?: string): string {
  const vectorized = columnRef("vectorized", alias);
  const disabled = columnRef("disabled", alias);
  const content = columnRef("content", alias);
  return `${vectorized} = 1 AND ${disabled} = 0 AND length(trim(COALESCE(${content}, ''))) > 0`;
}

export function worldBookVectorDesiredStatusSql(alias?: string): string {
  return `CASE WHEN ${worldBookVectorEligibilitySql(alias)} THEN 'pending' ELSE 'not_enabled' END`;
}

export function worldBookVectorStateDriftSql(alias?: string): string {
  const status = columnRef("vector_index_status", alias);
  const indexedAt = columnRef("vector_indexed_at", alias);
  const indexError = columnRef("vector_index_error", alias);
  const eligible = worldBookVectorEligibilitySql(alias);
  return `(
    (${eligible} AND (${status} != 'pending' OR ${status} IS NULL))
    OR (NOT (${eligible}) AND (${status} != 'not_enabled' OR ${status} IS NULL))
    OR ${indexedAt} IS NOT NULL
    OR ${indexError} IS NOT NULL
  )`;
}

export function worldBookVectorTrackingFingerprint(entry: VectorFingerprintEntry): string {
  return JSON.stringify({
    worldBookId: normalizeString(entry.world_book_id),
    updatedAt: Number(entry.updated_at ?? 0),
    vectorized: !!entry.vectorized,
    disabled: !!entry.disabled,
    content: normalizeString(entry.content),
    comment: normalizeString(entry.comment),
    key: normalizeStringArray(entry.key),
    keysecondary: normalizeStringArray(entry.keysecondary),
  });
}

export function worldBookVectorSettingsFingerprint(
  settings: Pick<WorldBookVectorSettings, "chunkTargetTokens" | "chunkMaxTokens" | "chunkOverlapTokens" | "maxChunksPerEntry">,
): string {
  return JSON.stringify({
    chunkTargetTokens: Number(settings.chunkTargetTokens ?? 0),
    chunkMaxTokens: Number(settings.chunkMaxTokens ?? 0),
    chunkOverlapTokens: Number(settings.chunkOverlapTokens ?? 0),
    maxChunksPerEntry: Number(settings.maxChunksPerEntry ?? 0),
  });
}
