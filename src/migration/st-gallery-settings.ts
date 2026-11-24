/**
 * CharacterLibrary settings detection, shared by the audit and the importer.
 *
 * CL defaults (library.js:626): unique folders OFF, lorebook scanning OFF.
 * The live settings.json overrides those so the importer reproduces exactly
 * what the ST install did when it localized media.
 */

import { LocalFileSystem } from "../file-connections/providers/local";
import type { FileSystem } from "../file-connections/types";

export interface ClSettings {
  uniqueGalleryFolders: boolean;
  includeLorebook: boolean;
  /** Rewrite imported chats too; off keeps chat text byte-identical to ST. */
  rewriteChats: boolean;
}

export async function detectClSettings(stDataDir: string, fs: FileSystem = new LocalFileSystem()): Promise<ClSettings> {
  const defaults: ClSettings = { uniqueGalleryFolders: false, includeLorebook: false, rewriteChats: true };
  try {
    const parsed = JSON.parse(await fs.readText(fs.join(stDataDir, "settings.json"))) as Record<string, unknown>;
    const extensionSettings = parsed.extension_settings;
    if (!extensionSettings || typeof extensionSettings !== "object") return defaults;
    const cl = (extensionSettings as Record<string, unknown>).SillyTavernCharacterGallery;
    if (!cl || typeof cl !== "object") return defaults;
    const settings = cl as Record<string, unknown>;
    return {
      uniqueGalleryFolders: settings.uniqueGalleryFolders === true,
      includeLorebook: settings.includeLorebook === true,
      // Absent means on: media localization is on by default in CL. A stored
      // `false` is the explicit opt-out.
      rewriteChats: settings.mediaLocalizationEnabled !== false,
    };
  } catch {
    return defaults;
  }
}
