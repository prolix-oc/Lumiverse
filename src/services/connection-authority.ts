/**
 * Connection rows restored from an archive retain their descriptive fields but
 * cannot become provider authority until the account owner explicitly reviews
 * and enables them. The marker lives in the existing metadata JSON so this
 * remains compatible with older connection schemas.
 */
export const IMPORT_REVIEW_METADATA_KEY = "__lumiverse_import_review_required";
export const IMPORT_REVIEW_CODE_KEY = "__lumiverse_import_review_code";

export function isImportedConnectionReviewRequired(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  return metadata?.[IMPORT_REVIEW_METADATA_KEY] === true;
}

export function importedConnectionReviewCode(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const value = metadata?.[IMPORT_REVIEW_CODE_KEY];
  return typeof value === "string" && value.trim() ? value : null;
}

export function sanitizeConnectionMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  delete next[IMPORT_REVIEW_METADATA_KEY];
  delete next[IMPORT_REVIEW_CODE_KEY];
  return next;
}

export function markImportedConnectionForReview(
  metadata: Record<string, unknown> | null | undefined,
  code = "foreign_import",
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [IMPORT_REVIEW_METADATA_KEY]: true,
    [IMPORT_REVIEW_CODE_KEY]: code,
  };
}

export function clearImportedConnectionReview(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  delete next[IMPORT_REVIEW_METADATA_KEY];
  delete next[IMPORT_REVIEW_CODE_KEY];
  return next;
}
