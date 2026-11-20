/**
 * Shared gallery-folder resolution.
 *
 * Used by both the read-only audit and the importer so the two can never
 * disagree about which on-disk folder belongs to a character. Extracted from
 * the audit's inline logic verbatim; behavior is unchanged.
 */

import { galleryFolderName, stSanitizeFilename } from "./cl-algorithms";
import type { FolderResolutionKind } from "./types";

/** Trailing segment of a unique gallery folder name: `{name}_{gallery_id}`. */
export const GALLERY_ID_SUFFIX_RE = /_([A-Za-z0-9]{8,16})$/;

/** Map every `_{gallery_id}` suffix found on disk to the folders carrying it. */
export function indexGalleryIdSuffixes(folderNames: readonly string[]): Map<string, string[]> {
  const bySuffix = new Map<string, string[]>();
  for (const name of folderNames) {
    const match = GALLERY_ID_SUFFIX_RE.exec(name);
    if (!match) continue;
    const list = bySuffix.get(match[1]!);
    if (list) list.push(name);
    else bySuffix.set(match[1]!, [name]);
  }
  return bySuffix;
}

export interface FolderResolution {
  folder: string | null;
  status: FolderResolutionKind;
}

/**
 * Resolve a card to its gallery folder, reproducing CL's fallbacks:
 *   1. `{sanitizeFolderName(name)}_{gallery_id}` as ST sanitized it on disk
 *   2. the CL-computed name verbatim (ST may not have re-sanitized it)
 *   3. the legacy plain-name folder
 *   4. a folder ending in `_{gallery_id}` — covers trailing-space drift and an
 *      ST rename of a CL-computed name
 * Returns no folder when nothing matches; callers must never guess, because a
 * wrong folder would attach another character's images.
 */
export function resolveGalleryFolder(
  name: string | null,
  galleryId: string | null,
  uniqueGalleryFolders: boolean,
  folderExists: (folder: string) => boolean,
  byGalleryIdSuffix: Map<string, string[]>,
): FolderResolution {
  if (!name) return { folder: null, status: "no_name" };

  const clName = galleryFolderName(name, galleryId, uniqueGalleryFolders);
  const onDisk = stSanitizeFilename(clName);
  if (folderExists(onDisk)) return { folder: onDisk, status: "resolved" };
  if (clName !== onDisk && folderExists(clName)) return { folder: clName, status: "resolved" };

  const legacy = stSanitizeFilename(name);
  if (legacy !== onDisk && folderExists(legacy)) return { folder: legacy, status: "legacy_name_only" };

  if (galleryId) {
    const candidates = byGalleryIdSuffix.get(galleryId);
    if (candidates && candidates.length === 1) return { folder: candidates[0]!, status: "gid_suffix_match" };
    if (candidates && candidates.length > 1) return { folder: null, status: "ambiguous_gid" };
  }

  return { folder: null, status: "no_folder" };
}
