/**
 * Shared helpers for reading/writing the character world book IDs array.
 * Handles backward compat with the legacy single `world_book_id` field.
 */

export function getCharacterWorldBookIds(extensions: Record<string, any> | undefined): string[] {
  if (!extensions) return [];
  const ids = extensions.world_book_ids;
  if (Array.isArray(ids)) return ids.filter((id: unknown) => typeof id === "string" && id);
  const single = extensions.world_book_id;
  if (typeof single === "string" && single) return [single];
  return [];
}

export function setCharacterWorldBookIds(
  extensions: Record<string, any>,
  ids: string[],
): Record<string, any> {
  const next: Record<string, any> = { ...extensions, world_book_ids: ids };
  delete next.world_book_id;
  return next;
}
