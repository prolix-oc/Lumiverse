/**
 * Direct SillyTavern gallery import.
 *
 * CharacterLibrary localized external media into per-character folders under
 * `<stDataDir>/user/images/`. This phase copies those files into Lumiverse,
 * registers them as gallery items, and rewrites the references that pointed at
 * them so they resolve locally.
 *
 * Rewrites, applied uniformly to character text, alternate greetings,
 * card-embedded lorebook entries, and imported chat messages:
 *   - `/user/images/<folder>/<file>` → `gallery://image-<k>`
 *   - a bare external media URL whose file was localized → the same reference,
 *     using CharacterLibrary's own matching rules
 *
 * Gallery items are registered in ascending-filename order, so canonical
 * references are minted as `image-1..N` in that order. The read-only audit
 * predicts exactly this sequence.
 *
 * Safety: a folder shared by several characters is never assigned — its images
 * could belong to any of them, and a wrong attachment is worse than a gap. The
 * same applies to an ambiguous `<gallery_id>` folder match and to URLs matching
 * more than one local file.
 */

import { extname } from "node:path";
import { LocalFileSystem } from "../file-connections/providers/local";
import type { FileSystem } from "../file-connections/types";
import type { Character } from "../types/character";
import { currentWorkerBudget } from "../utils/cpu-budget";
import { findGalleryImageReference } from "../utils/gallery-image-reference";
import { getDb } from "../db/connection";
import { getCharacter, updateCharacter } from "../services/characters.service";
import {
  addToGallery,
  listGallery,
  registerGalleryReferences,
} from "../services/character-gallery.service";
import { getImage, uploadImages } from "../services/images.service";
import { getWorldBook, listEntries, updateEntry } from "../services/world-books.service";
import {
  buildGalleryFileIndex,
  extractMediaUrls,
  lookupLocalizedMedia,
  type GalleryFileIndex,
} from "./st-gallery-audit/cl-algorithms";
import { readCardMetadata } from "./st-gallery-audit/png-metadata";
import { indexGalleryIdSuffixes, resolveGalleryFolder } from "./st-gallery-audit/resolve";
import { detectClSettings } from "./st-gallery-settings";
import type { MigrationLogger } from "./st-reader";

const MEDIA_EXTENSION_RE = /\.(png|jpg|jpeg|webp|gif|bmp|svg|mp3|wav|ogg|m4a|mp4|webm)$/i;
const PROGRESS_EVERY = 25;
/** Upload a bounded number of assets per request so memory stays flat. */
const UPLOAD_BATCH_FILES = 8;
const UPLOAD_BATCH_BYTES = 32 * 1024 * 1024;

const REWRITE_FIELDS = [
  "description",
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "creator_notes",
  "system_prompt",
  "post_history_instructions",
] as const;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const defaultFs = new LocalFileSystem();

export interface GalleryImportResult {
  imported: number;
  skipped: number;
  failed: number;
  /** Cards that received at least one gallery item. */
  charactersWithGallery: number;
  /** Character/book/chat fields rewritten to local references. */
  rewrites: number;
  /** Characters skipped because their folder is shared with another character. */
  contestedCharacters: number;
}

/** Key the importer rewrites in card text; also the auditing contract. */
export function localPathKey(folder: string, filename: string): string {
  return `/user/images/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace every key in `text` with its value. Longest key first so a short
 * filename cannot consume another path's prefix, and boundary guards so a
 * filename prefix or a same-looking path on another host is left alone —
 * identical to the CharacterLibrary bundle importer's rule.
 */
export function replaceReferences(text: string, mappings: ReadonlyMap<string, string>): string {
  let result = text;
  for (const [key, value] of [...mappings].sort((a, b) => b[0].length - a[0].length)) {
    result = result.replace(
      new RegExp(`(?<![\\w:/.-])${escapeRegExp(key)}(?![\\w%./-])`, "g"),
      () => value,
    );
  }
  return result;
}

/** The standalone world book representing this character's embedded book. */
function characterBookId(character: Character | null): string | null {
  if (!character) return null;
  const ids = character.extensions?.world_book_ids;
  if (!Array.isArray(ids)) return null;
  return typeof ids[0] === "string" ? ids[0] : null;
}

/** The card's embedded character_book payload, when present. */
function embeddedBook(character: Character): Record<string, unknown> | null {
  const book = character.extensions?.character_book;
  return book && typeof book === "object" && !Array.isArray(book)
    ? (book as Record<string, unknown>)
    : null;
}

/** Entries of the card's embedded character_book as a list. */
function embeddedBookEntries(character: Character): Array<Record<string, unknown>> {
  const entries = embeddedBook(character)?.entries;
  if (!entries) return [];
  const list = Array.isArray(entries) ? entries : Object.values(entries as Record<string, unknown>);
  return list.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object");
}

/**
 * Rewrites any text: local gallery paths always, and external media URLs whose
 * file was localized. One transformer keeps card text, lore and chats in sync.
 */
function createTextRewriter(
  folder: string,
  mappings: ReadonlyMap<string, string>,
  index: GalleryFileIndex,
  logger: MigrationLogger,
): (text: string) => string {
  return (text: string): string => {
    if (!text) return text;
    let result = replaceReferences(text, mappings);
    const urls = extractMediaUrls(result);
    for (const url of urls) {
      const lookup = lookupLocalizedMedia(index, url);
      if (lookup.status === "ambiguous") {
        logger.warn(`External URL matches multiple local files; left as-is: ${url}`);
        continue;
      }
      if (lookup.status !== "unique" || !lookup.file) continue;
      const reference = mappings.get(localPathKey(folder, lookup.file));
      if (!reference) continue;
      result = replaceReferences(result, new Map([[url, reference]]));
    }
    return result;
  };
}

interface PlannedGallery {
  filename: string;
  folder: string | null;
  card: unknown;
}

interface ImportedGallery {
  /** local path key → reference, used by the text rewriter. */
  mappings: Map<string, string>;
}

export async function importGalleryContent(
  userId: string,
  stDataDir: string,
  filenameToId: Map<string, string>,
  logger: MigrationLogger,
  fs: FileSystem = defaultFs,
): Promise<GalleryImportResult> {
  const result: GalleryImportResult = {
    imported: 0,
    skipped: 0,
    failed: 0,
    charactersWithGallery: 0,
    rewrites: 0,
    contestedCharacters: 0,
  };

  const charactersDir = fs.join(stDataDir, "characters");
  const imagesDir = fs.join(stDataDir, "user", "images");
  if (!(await fs.exists(imagesDir)) || !(await fs.exists(charactersDir))) return result;

  const settings = detectClSettings(stDataDir);
  const folderEntries = await fs.readdir(imagesDir);
  const folderNames = folderEntries.filter((entry) => entry.isDirectory).map((entry) => entry.name);
  if (folderNames.length === 0) return result;
  const folderSet = new Set(folderNames);
  const byGalleryIdSuffix = indexGalleryIdSuffixes(folderNames);

  const cardEntries = await fs.readdir(charactersDir);
  const cardFiles = cardEntries
    .filter((entry) => entry.isFile && fs.extname(entry.name).toLowerCase() === ".png")
    .map((entry) => entry.name);

  // Pass 1 — resolve folders and count owners, so a shared folder is detected
  // before any file in it is attributed to anyone.
  const folderOwners = new Map<string, string[]>();
  const plans: Array<PlannedGallery | null> = [];
  for (const filename of cardFiles) {
    const metadata = await readCardMetadata(fs, fs.join(charactersDir, filename)).catch(() => null);
    if (!metadata?.json) {
      plans.push(null);
      continue;
    }
    const card = metadata.json;
    const rawData = card.data;
    const data = (rawData && typeof rawData === "object" && !Array.isArray(rawData)
      ? rawData
      : card) as Record<string, unknown>;
    const rawExtensions = data.extensions;
    const extensions = rawExtensions && typeof rawExtensions === "object" && !Array.isArray(rawExtensions)
      ? (rawExtensions as Record<string, unknown>)
      : {};
    const { folder } = resolveGalleryFolder(
      typeof data.name === "string" ? data.name : null,
      typeof extensions.gallery_id === "string" ? extensions.gallery_id : null,
      settings.uniqueGalleryFolders,
      (candidate) => folderSet.has(candidate),
      byGalleryIdSuffix,
    );
    if (folder) {
      const owners = folderOwners.get(folder);
      if (owners) owners.push(filename);
      else folderOwners.set(folder, [filename]);
    }
    plans.push({ filename, folder, card });
  }

  // Pass 2 — import owned folders and rewrite references.
  const folderFileCache = new Map<string, string[]>();
  const readFolderFiles = async (folder: string): Promise<string[]> => {
    const cached = folderFileCache.get(folder);
    if (cached) return cached;
    const entries = await fs.readdir(fs.join(imagesDir, folder)).catch(() => []);
    const files = entries
      .filter((entry) => entry.isFile && MEDIA_EXTENSION_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    folderFileCache.set(folder, files);
    return files;
  };

  let processed = 0;
  for (const plan of plans) {
    if (!plan) continue;
    processed++;
    if (processed % PROGRESS_EVERY === 0) logger.progress("Importing gallery", processed, plans.length);
    if (!plan.folder) continue;

    const characterId = filenameToId.get(plan.filename.replace(/\.png$/i, ""));
    if (!characterId) continue;

    const owners = folderOwners.get(plan.folder) ?? [];
    if (owners.length > 1) {
      result.contestedCharacters++;
      logger.warn(
        `Gallery folder "${plan.folder}" is shared by ${owners.length} characters; skipping its images for "${plan.filename}"`,
      );
      continue;
    }

    try {
      const files = await readFolderFiles(plan.folder);
      if (files.length === 0) continue;

      const imported = await importCharacterGalleryAssets(userId, imagesDir, plan.folder, files, characterId, logger, fs, result);
      if (imported.mappings.size === 0) continue;

      const index = buildGalleryFileIndex(files);
      const rewrite = createTextRewriter(plan.folder, imported.mappings, index, logger);
      result.charactersWithGallery++;
      result.rewrites += rewriteCharacterReferences(userId, characterId, rewrite, logger);
      if (settings.rewriteChats) {
        result.rewrites += rewriteChatReferences(userId, plan.filename, rewrite);
      }
    } catch (err) {
      result.failed++;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Gallery import failed for "${plan.filename}": ${message}`);
    }
  }

  logger.progress("Importing gallery", plans.length, plans.length);
  return result;
}

/**
 * Upload a folder's files and register them as gallery items. Files already
 * registered to the character (same original filename) are reused, so re-running
 * the migration neither duplicates images nor changes existing references.
 */
async function importCharacterGalleryAssets(
  userId: string,
  imagesDir: string,
  folder: string,
  files: string[],
  characterId: string,
  logger: MigrationLogger,
  fs: FileSystem,
  result: GalleryImportResult,
): Promise<ImportedGallery> {
  // Every gallery item for this character, in registration order.
  const items = listGallery(userId, characterId, { registerReferences: false }).map((item) => ({
    id: item.id,
    image_id: item.image_id,
  }));
  const imageIdByOriginal = new Map<string, string>();
  for (const item of items) {
    const image = getImage(userId, item.image_id);
    if (image?.original_filename && !imageIdByOriginal.has(image.original_filename)) {
      imageIdByOriginal.set(image.original_filename, item.image_id);
    }
  }

  let pending: Array<{ filename: string; bytes: Uint8Array; mime: string }> = [];
  let pendingBytes = 0;

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    pendingBytes = 0;
    const results = await uploadImages(
      userId,
      batch.map((item) => ({
        data: item.bytes,
        filename: item.filename,
        mime_type: item.mime,
        owner_character_id: characterId,
      })),
      { concurrency: Math.max(1, Math.min(currentWorkerBudget().workerConcurrency, 8)), deferProcessing: true },
    );

    getDb().transaction(() => {
      for (let i = 0; i < batch.length; i++) {
        const uploaded = results[i];
        const file = batch[i]!;
        if (!uploaded?.image) {
          result.failed++;
          logger.warn(`Gallery asset upload failed: ${folder}/${file.filename} (${uploaded?.error ?? "unknown error"})`);
          continue;
        }
        try {
          const item = addToGallery(userId, characterId, uploaded.image.id, undefined, { registerReference: false });
          items.push({ id: item.id, image_id: uploaded.image.id });
          imageIdByOriginal.set(file.filename, uploaded.image.id);
          result.imported++;
        } catch (err) {
          result.failed++;
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`Gallery registration failed: ${folder}/${file.filename} (${message})`);
        }
      }
    })();
  };

  for (const filename of files) {
    if (imageIdByOriginal.has(filename)) {
      result.skipped++;
      continue;
    }
    try {
      const bytes = await fs.readFile(fs.join(imagesDir, folder, filename));
      if (pending.length > 0 && (pending.length >= UPLOAD_BATCH_FILES || pendingBytes + bytes.byteLength > UPLOAD_BATCH_BYTES)) {
        await flush();
      }
      pending.push({
        filename,
        bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        mime: MIME_BY_EXTENSION[extname(filename).toLowerCase()] ?? "application/octet-stream",
      });
      pendingBytes += bytes.byteLength;
    } catch (err) {
      result.failed++;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Could not read gallery asset ${folder}/${filename} (${message})`);
    }
  }
  await flush();

  // Mint canonical `gallery://image-<k>` references over the whole set, in
  // registration order. This is what the audit predicts and what makes the
  // rewrite idempotent: an existing item keeps the reference it already has.
  const registration = registerGalleryReferences(userId, characterId, items);

  const mappings = new Map<string, string>();
  for (const filename of files) {
    const imageId = imageIdByOriginal.get(filename);
    if (!imageId) continue;
    const reference = registration.referenceNames[imageId]
      ?? findGalleryImageReference(registration.assetMap, imageId);
    if (reference) mappings.set(localPathKey(folder, filename), reference);
  }
  return { mappings };
}

/**
 * Rewrite character text, alternate greetings, and lore so local references
 * resolve. Returns the number of fields changed.
 */
function rewriteCharacterReferences(
  userId: string,
  characterId: string,
  rewrite: (text: string) => string,
  logger: MigrationLogger,
): number {
  const character = getCharacter(userId, characterId);
  if (!character) return 0;

  let rewrites = 0;
  const patch: Record<string, unknown> = {};
  const fields = character as unknown as Record<string, string | undefined>;
  for (const field of REWRITE_FIELDS) {
    const current = fields[field];
    if (!current) continue;
    const next = rewrite(current);
    if (next !== current) {
      patch[field] = next;
      rewrites++;
    }
  }

  const greetings = character.alternate_greetings ?? [];
  const nextGreetings = greetings.map(rewrite);
  if (nextGreetings.some((value, index) => value !== greetings[index])) {
    patch.alternate_greetings = nextGreetings;
    rewrites++;
  }

  // Card-embedded lore. ST migration leaves it inside `extensions.character_book`;
  // if a standalone book exists for it (CL bundle imports), rewrite that instead.
  const bookId = characterBookId(character);
  const embeddedEntries = embeddedBookEntries(character);
  if (bookId && getWorldBook(userId, bookId)) {
    for (const entry of listEntries(userId, bookId)) {
      if (typeof entry.content !== "string") continue;
      const next = rewrite(entry.content);
      if (next === entry.content) continue;
      updateEntry(userId, entry.id, { content: next });
      rewrites++;
    }
  } else if (embeddedEntries.length > 0) {
    let changed = false;
    const nextEntries = embeddedEntries.map((entry) => {
      const content = entry.content;
      if (typeof content !== "string") return entry;
      const next = rewrite(content);
      if (next === content) return entry;
      changed = true;
      return { ...entry, content: next };
    });
    if (changed) {
      patch.extensions = { ...(character.extensions ?? {}), character_book: { ...embeddedBook(character), entries: nextEntries } };
      rewrites++;
    }
  }

  if (Object.keys(patch).length > 0) {
    updateCharacter(userId, characterId, patch as Parameters<typeof updateCharacter>[2], {
      emitEvent: false,
      preserveUpdatedAt: true,
    });
  }
  void logger;
  return rewrites;
}

/**
 * Rewrite this character's already-imported chats so local references resolve.
 * Runs after the chat phase so the rows exist.
 */
function rewriteChatReferences(
  userId: string,
  characterFilename: string,
  rewrite: (text: string) => string,
): number {
  const chatDirName = characterFilename.replace(/\.png$/i, "");
  const rows = getDb()
    .query(
      `SELECT m.id AS id, m.content AS content, m.swipes AS swipes FROM messages m
       JOIN chats c ON c.id = m.chat_id
       WHERE c.user_id = ? AND json_extract(c.metadata, '$._lumiverse_source_filename') LIKE ?`,
    )
    .all(userId, `chats/${chatDirName}/%`) as Array<{ id: string; content: string; swipes: string }>;
  if (rows.length === 0) return 0;

  let changed = 0;
  const update = getDb().query("UPDATE messages SET content = ?, swipes = ? WHERE id = ?");
  getDb().transaction(() => {
    for (const row of rows) {
      const nextContent = rewrite(row.content ?? "");
      let nextSwipes = row.swipes;
      try {
        const parsed = JSON.parse(row.swipes ?? "[]");
        if (Array.isArray(parsed)) {
          const mapped = parsed.map((swipe) => (typeof swipe === "string" ? rewrite(swipe) : swipe));
          if (mapped.some((value, index) => value !== parsed[index])) nextSwipes = JSON.stringify(mapped);
        }
      } catch {
        // A malformed swipes blob is left untouched rather than replaced.
      }
      if (nextContent !== row.content || nextSwipes !== row.swipes) {
        update.run(nextContent, nextSwipes, row.id);
        changed++;
      }
    }
  })();
  return changed;
}

/** Exposed for tests. */
export const __testing = { characterBookId, embeddedBookEntries };
