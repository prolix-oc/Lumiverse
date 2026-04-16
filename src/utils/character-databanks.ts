/**
 * Shared helpers for reading/writing the character databank IDs array.
 * Mirrors the character-world-books.ts pattern.
 */

export function getCharacterDatabankIds(extensions: Record<string, any> | undefined): string[] {
  if (!extensions) return [];
  const ids = extensions.databank_ids;
  if (Array.isArray(ids)) return ids.filter((id: unknown) => typeof id === "string" && id);
  return [];
}

export function setCharacterDatabankIds(
  extensions: Record<string, any>,
  ids: string[],
): Record<string, any> {
  return { ...extensions, databank_ids: ids };
}
