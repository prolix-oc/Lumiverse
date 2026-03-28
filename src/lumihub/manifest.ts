/**
 * Install Manifest — builds a lightweight summary of all installed characters
 * and world books for sync to LumiHub, enabling remote "Update" detection.
 */
import * as charactersSvc from "../services/characters.service";
import * as worldBooksSvc from "../services/world-books.service";

export interface ManifestEntry {
  slug: string;
  type: "character" | "worldbook";
  name: string;
  creator: string;
  source: "local" | "chub" | "lumihub";
  installed_at: number;
}

/**
 * Slugify a string: lowercase, replace whitespace/special chars with hyphens,
 * collapse multiple hyphens, trim leading/trailing hyphens.
 */
function slugify(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Build a `creator/name` slug from character or world book fields. */
export function buildSlug(creator: string, name: string): string {
  const c = slugify(creator || "unknown");
  const n = slugify(name || "unnamed");
  return `${c}/${n}`;
}

/** @deprecated Use buildSlug instead */
export const buildCharacterSlug = buildSlug;

/**
 * Build the full install manifest for a user.
 * Returns a lightweight array suitable for syncing to LumiHub.
 */
export function buildInstallManifest(userId: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];

  // Characters
  const characters = charactersSvc.listCharactersForManifest(userId);
  for (const char of characters) {
    const source = char.extensions?._lumiverse_install_source as string | undefined;
    // Prefer canonical Chub slug (fullPath) so it matches LumiHub's card.id lookup
    const chubSlug = char.extensions?._lumiverse_chub_slug as string | undefined;
    const slug = (source === "chub" && chubSlug) ? chubSlug : buildSlug(char.creator, char.name);
    entries.push({
      slug,
      type: "character",
      name: char.name,
      creator: char.creator,
      source: source === "chub" ? "chub" : source === "lumihub" ? "lumihub" : "local",
      installed_at: char.created_at,
    });
  }

  // World books
  const worldBooks = worldBooksSvc.listWorldBooksForManifest(userId);
  for (const wb of worldBooks) {
    const source = wb.metadata?._lumiverse_install_source as string | undefined;
    const creator = (wb.metadata?.source_creator as string) || "unknown";
    const slug = buildSlug(creator, wb.name);
    entries.push({
      slug,
      type: "worldbook",
      name: wb.name,
      creator,
      source: source === "chub" ? "chub" : source === "lumihub" ? "lumihub" : "local",
      installed_at: wb.created_at,
    });
  }

  return entries;
}
