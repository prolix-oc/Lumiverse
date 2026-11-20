import * as characters from "./characters.service";
import * as images from "./images.service";
import * as card from "./character-card.service";
import * as characterLora from "./character-lora.service";
import * as regex from "./regex-scripts.service";
import * as worldBooks from "./world-books.service";
import { applyCharxModulesAndAssets, autoImportEmbeddedWorldbook } from "./charx-import.service";
import type { Character } from "../types/character";

export interface CharacterFileImportResult {
  filename: string;
  success: boolean;
  character?: Character;
  lorebook?: { name: string; entryCount: number };
  lumiverse_lora?: characterLora.PortableLoraReference;
  error?: string;
  skipped?: boolean;
}

export interface CharacterFileImportOptions {
  skipDuplicates?: boolean;
  /** Bulk workflows suppress the large per-character WebSocket payload. */
  emitEvent?: boolean;
}

function importCardRegexBestEffort(userId: string, characterId: string, extensions: unknown): void {
  try {
    regex.importCharacterBoundRegexScripts(userId, characterId, extensions);
  } catch (err) {
    console.error("[character import] regex import failed:", err);
  }
}

function portableLoraSurface(
  character: Character | null | undefined,
): { lumiverse_lora?: characterLora.PortableLoraReference } {
  const ref = character ? characterLora.readPortableLoraReference(character) : null;
  return ref ? { lumiverse_lora: ref } : {};
}

/**
 * Import one already-bounded character-card file. Transport concerns belong to
 * callers: HTTP bulk jobs stage raw request bodies to disk before invoking this
 * function, while the legacy multipart endpoint can continue passing a File.
 */
export async function importCharacterFile(
  userId: string,
  file: File,
  options: CharacterFileImportOptions = {},
): Promise<CharacterFileImportResult> {
  const filename = file.name || "unknown";
  let cardInput;
  let pngAvatar: File | null = null;
  let charxResult: card.CharxResult | null = null;

  const detectedFormat = await card.detectCharacterImportFormat(file);
  if (detectedFormat === "png") {
    cardInput = await card.extractCardFromPng(file);
    pngAvatar = file;
  } else if (detectedFormat === "charx" || detectedFormat === "jpeg_polyglot") {
    charxResult = await card.extractCardFromCharx(file);
    cardInput = charxResult.card;
  } else if (detectedFormat === "jpeg") {
    throw new Error("JPEG file does not contain embedded character card data");
  } else {
    const text = await file.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("Invalid JSON in uploaded character card");
    }
    cardInput = card.parseCardJson(json);
  }

  if (options.skipDuplicates) {
    const hasRealFilename = filename !== "unknown" && filename !== "";
    const existingByFile = hasRealFilename
      ? characters.findCharacterBySourceFilename(userId, filename)
      : null;
    if (existingByFile) {
      return {
        filename,
        success: true,
        skipped: true,
        character: existingByFile,
        ...portableLoraSurface(existingByFile),
      };
    }

    if (!hasRealFilename && characters.characterExistsByName(userId, cardInput.name)) {
      const existing = characters.findCharactersByName(userId, cardInput.name)[0];
      return {
        filename,
        success: true,
        skipped: true,
        character: existing,
        ...portableLoraSurface(existing),
      };
    }
  }

  const character = characters.createCharacter(userId, cardInput, {
    emitEvent: options.emitEvent,
  });

  if (filename !== "unknown" && filename !== "") {
    characters.setCharacterSourceFilename(userId, character.id, filename);
  }

  if (charxResult) {
    await applyCharxModulesAndAssets(userId, character, charxResult);
  } else {
    if (pngAvatar) {
      const image = await images.uploadImage(userId, pngAvatar, {
        owner_character_id: character.id,
      });
      characters.setCharacterImage(userId, character.id, image.id);
      characters.setCharacterAvatar(userId, character.id, image.filename);
    }
    importCardRegexBestEffort(userId, character.id, cardInput.extensions);
    autoImportEmbeddedWorldbook(userId, character.id);
  }

  const imported = (await characters.getCharacterAsync(userId, character.id))!;
  const charBook = imported.extensions?.character_book;
  const entryCount = worldBooks.countImportedWorldBookEntries(charBook?.entries);
  const lorebook = entryCount > 0
    ? {
        name: charBook.name || `${imported.name}'s Lorebook`,
        entryCount,
      }
    : undefined;

  return {
    filename,
    success: true,
    character: imported,
    lorebook,
    ...portableLoraSurface(imported),
  };
}
