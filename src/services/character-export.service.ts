import sharp from "sharp";
import { extname } from "path";
import { zipSync } from "fflate";
import { getCharacter } from "./characters.service";
import { getExpressionConfig, getExpressionGroups } from "./expressions.service";
import { listGallery } from "./character-gallery.service";
import { getImage, getImageFilePath } from "./images.service";
import { exportWorldBook, getWorldBook } from "./world-books.service";
import { isNsfwExpressionLabel } from "./character-card.service";
import { getCharacterBoundScripts } from "./regex-scripts.service";
import { getCharacterWorldBookIds } from "../utils/character-world-books";
import type { Character } from "../types/character";

// ── CRC-32 (lookup table) ───────────────────────────────────────────────────

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c;
}

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ── PNG text chunk embedding ────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Embeds a tEXt chunk into a PNG buffer, inserted before the first IDAT chunk.
 * The text value is stored as-is (already base64-encoded by caller).
 */
export function embedPngTextChunk(pngBuffer: Buffer, keyword: string, textValue: string): Buffer {
  if (pngBuffer.length < 8 || !pngBuffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Not a valid PNG file");
  }

  // Build the tEXt chunk data: keyword + null byte + text
  const keywordBytes = Buffer.from(keyword, "ascii");
  const textBytes = Buffer.from(textValue, "latin1");
  const chunkData = Buffer.concat([keywordBytes, Buffer.from([0]), textBytes]);

  // Build chunk type + data for CRC calculation
  const chunkType = Buffer.from("tEXt", "ascii");
  const crcInput = Buffer.concat([chunkType, chunkData]);
  const crcValue = crc32(new Uint8Array(crcInput));

  // Full chunk: length(4 BE) + type(4) + data + CRC(4 BE)
  const chunk = Buffer.alloc(4 + 4 + chunkData.length + 4);
  chunk.writeUInt32BE(chunkData.length, 0);
  chunkType.copy(chunk, 4);
  chunkData.copy(chunk, 8);
  chunk.writeUInt32BE(crcValue, 8 + chunkData.length);

  // Find insertion point: just before the first IDAT chunk
  let offset = 8; // skip PNG signature
  while (offset + 12 <= pngBuffer.length) {
    const length = pngBuffer.readUInt32BE(offset);
    const type = pngBuffer.toString("ascii", offset + 4, offset + 8);

    if (type === "IDAT") {
      // Insert our tEXt chunk here
      const before = pngBuffer.subarray(0, offset);
      const after = pngBuffer.subarray(offset);
      return Buffer.concat([before, chunk, after]);
    }

    // Move to next chunk: length(4) + type(4) + data(length) + crc(4)
    offset += 4 + 4 + length + 4;
  }

  // No IDAT found (unusual) — insert before IEND as fallback
  // Find IEND
  offset = 8;
  while (offset + 12 <= pngBuffer.length) {
    const length = pngBuffer.readUInt32BE(offset);
    const type = pngBuffer.toString("ascii", offset + 4, offset + 8);

    if (type === "IEND") {
      const before = pngBuffer.subarray(0, offset);
      const after = pngBuffer.subarray(offset);
      return Buffer.concat([before, chunk, after]);
    }

    offset += 4 + 4 + length + 4;
  }

  throw new Error("Could not find a suitable insertion point in PNG");
}

// ── Image reading helpers ───────────────────────────────────────────────────

interface ImageBytes {
  bytes: Uint8Array;
  ext: string;
  mime: string;
  filename: string;
}

async function readImageBytes(userId: string, imageId: string): Promise<ImageBytes | null> {
  const image = getImage(userId, imageId);
  if (!image) return null;

  const filepath = await getImageFilePath(userId, imageId);
  if (!filepath) return null;

  const buffer = await Bun.file(filepath).arrayBuffer();
  const ext = extname(image.filename) || ".png";
  return {
    bytes: new Uint8Array(buffer),
    ext,
    mime: image.mime_type || "image/png",
    filename: image.filename,
  };
}

// ── CCSv3 JSON builder ──────────────────────────────────────────────────────

/** Extension keys that are Lumiverse-internal and should not leak into CCSv3 exports. */
const INTERNAL_EXTENSION_KEYS = new Set([
  "expressions",
  "expression_groups",
  "alternate_fields",
  "alternate_avatars",
  "world_book_id",
  "world_book_ids",
  "_lumiverse_source_filename",
  "risu_asset_map",
]);

export function buildCCSv3Json(userId: string, character: Character): Record<string, any> {
  // Build clean extensions (strip internal keys)
  const cleanExtensions: Record<string, any> = {};
  if (character.extensions) {
    for (const [key, value] of Object.entries(character.extensions)) {
      if (!INTERNAL_EXTENSION_KEYS.has(key)) {
        cleanExtensions[key] = value;
      }
    }
  }

  // Build the data payload
  const data: Record<string, any> = {
    name: character.name,
    description: character.description || "",
    personality: character.personality || "",
    scenario: character.scenario || "",
    first_mes: character.first_mes || "",
    mes_example: character.mes_example || "",
    creator: character.creator || "",
    creator_notes: character.creator_notes || "",
    system_prompt: character.system_prompt || "",
    post_history_instructions: character.post_history_instructions || "",
    tags: character.tags || [],
    alternate_greetings: character.alternate_greetings || [],
  };

  // Embed character_book from attached world books
  const attachedBookIds = getCharacterWorldBookIds(character.extensions);
  if (attachedBookIds.length > 0) {
    const characterBook = mergeWorldBooksForExport(userId, attachedBookIds);
    if (characterBook) {
      data.character_book = characterBook;
    }
  }

  // Also include any character_book already in extensions (from import)
  if (!data.character_book && character.extensions?.character_book) {
    data.character_book = character.extensions.character_book;
  }

  // Include character_version if present
  if (cleanExtensions.character_version !== undefined) {
    data.character_version = cleanExtensions.character_version;
    delete cleanExtensions.character_version;
  }

  if (Object.keys(cleanExtensions).length > 0) {
    data.extensions = cleanExtensions;
  }

  return {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data,
  };
}

/**
 * Merge multiple world books into a single character_book object for CCSv3 export.
 * If only one book, returns it directly. If multiple, concatenates entries with
 * re-indexed IDs and [BookName] comment prefixes for traceability.
 */
function mergeWorldBooksForExport(userId: string, bookIds: string[]): Record<string, any> | null {
  if (bookIds.length === 1) {
    return exportWorldBook(userId, bookIds[0], "character_book");
  }

  const allEntries: Record<string, any>[] = [];
  const bookNames: string[] = [];

  for (const bookId of bookIds) {
    const exported = exportWorldBook(userId, bookId, "character_book");
    if (!exported?.entries) continue;
    const book = getWorldBook(userId, bookId);
    const bookName = book?.name || "Unknown Book";
    bookNames.push(bookName);

    for (const entry of exported.entries) {
      allEntries.push({
        ...entry,
        id: allEntries.length,
        comment: `[${bookName}] ${entry.comment || ""}`.trim(),
      });
    }
  }

  if (allEntries.length === 0) return null;

  return {
    name: bookNames.length > 1 ? `Merged Lorebook (${bookNames.length} books)` : bookNames[0] || "Lorebook",
    description: `Merged from: ${bookNames.join(", ")}`,
    entries: allEntries,
  };
}

// ── Export: JSON ─────────────────────────────────────────────────────────────

export function exportAsJson(userId: string, characterId: string): Record<string, any> | null {
  const character = getCharacter(userId, characterId);
  if (!character) return null;
  return buildCCSv3Json(userId, character);
}

// ── Export: PNG ──────────────────────────────────────────────────────────────

export async function exportAsPng(userId: string, characterId: string): Promise<Buffer | null> {
  const character = getCharacter(userId, characterId);
  if (!character) return null;

  // Get avatar image
  let avatarBuffer: Buffer | null = null;

  if (character.image_id) {
    const filepath = await getImageFilePath(userId, character.image_id);
    if (filepath) {
      avatarBuffer = Buffer.from(await Bun.file(filepath).arrayBuffer());
    }
  }

  if (!avatarBuffer) {
    // Create a minimal placeholder PNG (1x1 transparent) if no avatar
    avatarBuffer = await sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
  }

  // Ensure it's PNG format
  const metadata = await sharp(avatarBuffer).metadata();
  if (metadata.format !== "png") {
    avatarBuffer = await sharp(avatarBuffer).png().toBuffer();
  }

  // Build CCSv3 JSON and base64-encode it
  const ccsv3 = buildCCSv3Json(userId, character);
  const jsonStr = JSON.stringify(ccsv3);
  const base64 = Buffer.from(jsonStr, "utf-8").toString("base64");

  // Embed as tEXt chunk with "ccv3" keyword
  return embedPngTextChunk(avatarBuffer, "ccv3", base64);
}

// ── Export: CHARX ───────────────────────────────────────────────────────────

export interface LumiverseModulesExport {
  version: number;
  /** True when any expression label matches NSFW content keywords. */
  has_nsfw_expressions?: boolean;
  expressions?: {
    enabled: boolean;
    defaultExpression: string;
    mappings: Record<string, string>; // label → archive path
  };
  /** Multi-character expression groups: characterName → { label → archivePath }. */
  expression_groups?: {
    groups: Record<string, Record<string, string>>;
  };
  alternate_fields?: Record<string, Array<{ id: string; label: string; content: string }>>;
  alternate_avatars?: Array<{ id: string; label: string; path: string }>;
  world_books?: Record<string, any>[];
  regex_scripts?: import("./character-card.service").BundledRegexScript[];
}

/** Sanitize a string for use as a filename component inside the archive. */
function sanitizeArchiveName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-. ]/g, "_").trim() || "unnamed";
}

export async function exportAsCharx(userId: string, characterId: string): Promise<Uint8Array | null> {
  const character = getCharacter(userId, characterId);
  if (!character) return null;

  const ccsv3 = buildCCSv3Json(userId, character);
  const entries: Record<string, Uint8Array> = {};

  // card.json at root
  entries["card.json"] = new TextEncoder().encode(JSON.stringify(ccsv3, null, 2));

  // Primary avatar — CHARX spec: assets/{category}/{type}/{filename}
  if (character.image_id) {
    const img = await readImageBytes(userId, character.image_id);
    if (img) {
      entries[`assets/icon/image/main${img.ext}`] = img.bytes;
    }
  }

  // Build lumiverse_modules.json
  const modules: LumiverseModulesExport = { version: 1 };

  // Expression images
  const exprConfig = getExpressionConfig(userId, characterId);
  if (exprConfig && Object.keys(exprConfig.mappings).length > 0) {
    const exprMappings: Record<string, string> = {};
    for (const [label, imageId] of Object.entries(exprConfig.mappings)) {
      const img = await readImageBytes(userId, imageId);
      if (img) {
        const safeName = sanitizeArchiveName(label);
        const archivePath = `assets/other/image/expr_${safeName}${img.ext}`;
        entries[archivePath] = img.bytes;
        exprMappings[label] = archivePath;
      }
    }
    if (Object.keys(exprMappings).length > 0) {
      modules.expressions = {
        enabled: exprConfig.enabled,
        defaultExpression: exprConfig.defaultExpression,
        mappings: exprMappings,
      };
      if (Object.keys(exprMappings).some(isNsfwExpressionLabel)) {
        modules.has_nsfw_expressions = true;
      }
    }
  }

  // Multi-character expression groups
  const exprGroups = getExpressionGroups(userId, characterId);
  if (exprGroups && Object.keys(exprGroups).length > 0) {
    const groupMappings: Record<string, Record<string, string>> = {};

    for (const [groupName, labels] of Object.entries(exprGroups)) {
      const safeName = sanitizeArchiveName(groupName);
      const labelMappings: Record<string, string> = {};

      for (const [label, imageId] of Object.entries(labels)) {
        const img = await readImageBytes(userId, imageId);
        if (img) {
          const safeLabel = sanitizeArchiveName(label);
          const archivePath = `assets/other/image/exprg_${safeName}--${safeLabel}${img.ext}`;
          entries[archivePath] = img.bytes;
          labelMappings[label] = archivePath;
          if (isNsfwExpressionLabel(label)) modules.has_nsfw_expressions = true;
        }
      }

      if (Object.keys(labelMappings).length > 0) {
        groupMappings[groupName] = labelMappings;
      }
    }

    if (Object.keys(groupMappings).length > 0) {
      modules.expression_groups = { groups: groupMappings };
    }
  }

  // Gallery images
  const galleryItems = listGallery(userId, characterId);
  for (const item of galleryItems) {
    const img = await readImageBytes(userId, item.image_id);
    if (img) {
      entries[`assets/other/image/gallery_${item.id}${img.ext}`] = img.bytes;
    }
  }

  // Alternate fields
  const altFields = character.extensions?.alternate_fields;
  if (altFields && typeof altFields === "object") {
    const hasAny = Object.values(altFields).some(
      (arr: any) => Array.isArray(arr) && arr.length > 0
    );
    if (hasAny) {
      modules.alternate_fields = altFields;
    }
  }

  // Alternate avatars
  const altAvatars: Array<{ id: string; label: string; path: string }> = [];
  const altAvatarEntries = character.extensions?.alternate_avatars;
  if (Array.isArray(altAvatarEntries)) {
    for (const entry of altAvatarEntries) {
      if (!entry.image_id || !entry.label) continue;
      const img = await readImageBytes(userId, entry.image_id);
      if (img) {
        const archivePath = `assets/icon/image/${entry.id}${img.ext}`;
        entries[archivePath] = img.bytes;
        altAvatars.push({ id: entry.id, label: entry.label, path: archivePath });
      }
    }
  }
  if (altAvatars.length > 0) {
    modules.alternate_avatars = altAvatars;
  }

  // World books (individual Lumiverse-format exports for lossless round-trips)
  const charWorldBookIds = getCharacterWorldBookIds(character.extensions);
  if (charWorldBookIds.length > 0) {
    const worldBooksExport: Record<string, any>[] = [];
    for (const wbId of charWorldBookIds) {
      const exported = exportWorldBook(userId, wbId, "lumiverse");
      if (exported) worldBooksExport.push(exported);
    }
    if (worldBooksExport.length > 0) {
      modules.world_books = worldBooksExport;
    }
  }

  // Character-bound regex scripts
  const boundScripts = getCharacterBoundScripts(userId, characterId);
  if (boundScripts.length > 0) {
    modules.regex_scripts = boundScripts.map((s) => ({
      name: s.name,
      find_regex: s.find_regex,
      replace_string: s.replace_string,
      flags: s.flags,
      placement: s.placement,
      scope: s.scope,
      scope_id: null, // Will be rebound to new character on import
      target: s.target,
      min_depth: s.min_depth,
      max_depth: s.max_depth,
      trim_strings: s.trim_strings,
      run_on_edit: s.run_on_edit,
      substitute_macros: s.substitute_macros,
      disabled: s.disabled,
      sort_order: s.sort_order,
      description: s.description,
      metadata: { ...s.metadata, source: "charx_bundle" },
    }));
  }

  // Only include lumiverse_modules.json if there's content
  const hasModules =
    modules.expressions || modules.expression_groups || modules.alternate_fields || modules.alternate_avatars || modules.world_books?.length || modules.regex_scripts;
  if (hasModules) {
    entries["lumiverse_modules.json"] = new TextEncoder().encode(
      JSON.stringify(modules, null, 2)
    );
  }

  return zipSync(entries);
}

// ── Filename sanitizer for Content-Disposition ──────────────────────────────

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-. ]/g, "_").trim() || "character";
}
