import { getDb } from "../db/connection";
import { executeDatabaseOperation } from '../db/execution';
import { readDatabaseRow } from '../db/queries';
import { GALLERY_REFERENCE_NAMES_KEY } from '../db/gallery-operations';
export { GALLERY_REFERENCE_NAMES_KEY } from '../db/gallery-operations';
import { deleteImageIfUnreferenced, deleteImageIfUnreferencedAsync, uploadImageDeferred } from "./images.service";
import { getCharacter, updateCharacter, getCharacterAsync, rowToCharacter, collectCharacterImageIds } from "./characters.service";
import type { CharacterGalleryItem, GalleryItemRemoval } from "../types/character-gallery";
import { safeFetch } from "../utils/safe-fetch";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import {
  createCanonicalGalleryImageReference,
  createGalleryImageReference,
  findGalleryImageReference,
  normalizeGalleryImageReferenceName,
  parseCanonicalGalleryImageReference,
  parseGalleryImageReference,
} from "../utils/gallery-image-reference";

const GALLERY_REFERENCE_SEQUENCE_KEY = "gallery_reference_sequence";

interface GalleryReferenceRegistration {
  assetMap: Record<string, string>;
  referenceNames: Record<string, string>;
}

export class GalleryReferenceConflictError extends Error {
  constructor() {
    super("That gallery reference name is already in use");
    this.name = "GalleryReferenceConflictError";
  }
}

export class InvalidGalleryReferenceNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGalleryReferenceNameError";
  }
}

function asStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function primaryGalleryReference(
  assetMap: Record<string, string>,
  referenceNames: Record<string, string>,
  imageId: string,
  preferredToken?: string,
): string | null {
  const namedReference = referenceNames[imageId];
  if (namedReference && assetMap[namedReference] === imageId && parseGalleryImageReference(namedReference)) {
    return namedReference;
  }
  return findGalleryImageReference(assetMap, imageId, preferredToken);
}

function rowToGalleryItem(
  row: any,
  assetMap: Record<string, string> = {},
  referenceNames: Record<string, string> = {},
): CharacterGalleryItem {
  const reference = primaryGalleryReference(assetMap, referenceNames, row.image_id, row.id)
    ?? createGalleryImageReference(row.id);
  return {
    id: row.id,
    image_id: row.image_id,
    reference,
    caption: row.caption ?? "",
    sort_order: row.sort_order ?? 0,
    created_at: row.created_at,
    width: row.width ?? null,
    height: row.height ?? null,
    mime_type: row.mime_type ?? "",
  };
}

export function listGallery(
  userId: string,
  characterId: string,
  options: { registerReferences?: boolean } = {},
): CharacterGalleryItem[] {
  const rows = getDb()
    .query(
      `SELECT g.id, g.image_id, g.caption, g.sort_order, g.created_at,
              i.width, i.height, i.mime_type
       FROM character_gallery g
       JOIN images i ON i.id = g.image_id
       WHERE g.user_id = ? AND g.character_id = ?
       ORDER BY g.sort_order`
    )
    .all(userId, characterId) as any[];

  let registration: GalleryReferenceRegistration;
  if (options.registerReferences === false) {
    // Read-only consumers retain saved references and legacy item-ID fallbacks.
    const character = getCharacter(userId, characterId);
    registration = {
      assetMap: asStringMap(character?.extensions?.risu_asset_map),
      referenceNames: asStringMap(character?.extensions?.[GALLERY_REFERENCE_NAMES_KEY]),
    };
  } else {
    registration = registerGalleryReferences(userId, characterId, rows);
  }
  return rows.map((row) => rowToGalleryItem(row, registration.assetMap, registration.referenceNames));
}

const GALLERY_REFERENCE_IN_TEXT_RE = /gallery:\/\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/g;

function replaceGalleryReferences(
  value: string,
  replacements: Map<string, string>,
): string {
  return value.replace(GALLERY_REFERENCE_IN_TEXT_RE, (reference) => replacements.get(reference) ?? reference);
}

function replaceGalleryReferencesDeep(value: unknown, replacements: Map<string, string>): unknown {
  if (typeof value === "string") return replaceGalleryReferences(value, replacements);
  if (Array.isArray(value)) return value.map((entry) => replaceGalleryReferencesDeep(entry, replacements));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      replaceGalleryReferences(key, replacements),
      replaceGalleryReferencesDeep(entry, replacements),
    ]),
  );
}

export function registerGalleryReferences(
  userId: string,
  characterId: string,
  items: Array<Pick<CharacterGalleryItem, "id" | "image_id">>,
): GalleryReferenceRegistration {
  if (items.length === 0) return { assetMap: {}, referenceNames: {} };
  const character = getCharacter(userId, characterId);
  if (!character) return { assetMap: {}, referenceNames: {} };
  const assetMap = asStringMap(character.extensions?.risu_asset_map);
  const referenceNames = asStringMap(character.extensions?.[GALLERY_REFERENCE_NAMES_KEY]);
  let changed = false;
  const storedSequence = Number.isSafeInteger(character.extensions?.[GALLERY_REFERENCE_SEQUENCE_KEY])
    ? Math.max(0, character.extensions[GALLERY_REFERENCE_SEQUENCE_KEY])
    : 0;
  let sequence = storedSequence;
  for (const reference of Object.keys(assetMap)) {
    sequence = Math.max(sequence, parseCanonicalGalleryImageReference(reference) ?? 0);
  }
  if (sequence !== storedSequence) changed = true;
  const replacements = new Map<string, string>();
  for (const item of items) {
    let reference = primaryGalleryReference(assetMap, referenceNames, item.image_id);
    if (!reference) {
      reference = createCanonicalGalleryImageReference(++sequence);
      assetMap[reference] = item.image_id;
      changed = true;
    }
    if (referenceNames[item.image_id] !== reference) {
      referenceNames[item.image_id] = reference;
      changed = true;
    }
    const legacyReference = createGalleryImageReference(item.id);
    if (legacyReference !== reference) replacements.set(legacyReference, reference);
  }
  if (changed) {
    const replace = (value: string) => replaceGalleryReferences(value, replacements);
    const updates: Parameters<typeof updateCharacter>[2] = {
      extensions: {
        ...(character.extensions || {}),
        risu_asset_map: assetMap,
        [GALLERY_REFERENCE_SEQUENCE_KEY]: sequence,
        [GALLERY_REFERENCE_NAMES_KEY]: referenceNames,
      },
    };
    const textFields = [
      "first_mes",
      "description",
      "personality",
      "scenario",
      "mes_example",
      "system_prompt",
      "post_history_instructions",
      "creator_notes",
    ] as const;
    for (const field of textFields) {
      const currentValue = character[field] || "";
      const nextValue = replace(currentValue);
      if (nextValue !== currentValue) updates[field] = nextValue;
    }
    const alternateGreetings = character.alternate_greetings || [];
    const nextAlternateGreetings = alternateGreetings.map(replace);
    if (nextAlternateGreetings.some((value, index) => value !== alternateGreetings[index])) {
      updates.alternate_greetings = nextAlternateGreetings;
    }
    updateCharacter(userId, characterId, updates);
  }
  return { assetMap, referenceNames };
}

export function addToGallery(
  userId: string,
  characterId: string,
  imageId: string,
  caption?: string,
  options: { registerReference?: boolean } = {},
): CharacterGalleryItem {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  getDb()
    .query(
      `INSERT INTO character_gallery (id, user_id, character_id, image_id, caption, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, userId, characterId, imageId, caption ?? "", 0, now);

  if (options.registerReference !== false) {
    registerGalleryReferences(userId, characterId, [{ id, image_id: imageId }]);
  }
  return getGalleryItem(userId, id)!;
}

/** Insert used by background flows (image-gen auto-link) that do not need the resulting row. */
export function linkImageToGallery(
  userId: string,
  characterId: string,
  imageId: string,
  caption?: string
): void {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .query(
      `INSERT INTO character_gallery (id, user_id, character_id, image_id, caption, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, userId, characterId, imageId, caption ?? "", 0, now);
  registerGalleryReferences(userId, characterId, [{ id, image_id: imageId }]);
}

export async function uploadToGallery(
  userId: string,
  characterId: string,
  file: File,
  caption?: string,
  options: { registerReference?: boolean } = {},
): Promise<CharacterGalleryItem> {
  const image = await uploadImageDeferred(userId, file, { owner_character_id: characterId });
  return addToGallery(userId, characterId, image.id, caption, options);
}

export interface BulkGallerySkippedFile {
  name: string;
  reason: string;
}

export interface BulkGalleryUploadResult {
  items: CharacterGalleryItem[];
  skipped: BulkGallerySkippedFile[];
}

/**
 * Upload multiple images to a character's gallery in one call.
 * Emits IMPORT_GALLERY_PROGRESS WS events so the frontend can track progress.
 * Returns both successful items and any files that were skipped (oversized,
 * runtime failure, etc.) so the caller can surface them to the user.
 */
export async function uploadBulkToGallery(
  userId: string,
  characterId: string,
  files: File[],
  preSkipped: BulkGallerySkippedFile[] = [],
): Promise<BulkGalleryUploadResult> {
  const total = files.length;
  const items: CharacterGalleryItem[] = [];
  const skipped: BulkGallerySkippedFile[] = [...preSkipped];

  for (let i = 0; i < total; i++) {
    eventBus.emit(
      EventType.IMPORT_GALLERY_PROGRESS,
      { characterId, current: i + 1, total, filename: files[i].name },
      userId,
    );
    try {
      const item = await uploadToGallery(userId, characterId, files[i], undefined, { registerReference: false });
      items.push(item);
    } catch (err: any) {
      skipped.push({
        name: files[i].name || "unknown",
        reason: err?.message ?? "upload failed",
      });
    }
  }

  const registration = registerGalleryReferences(userId, characterId, items);
  for (const item of items) {
    item.reference = primaryGalleryReference(
      registration.assetMap,
      registration.referenceNames,
      item.image_id,
    )
      ?? item.reference;
  }

  return { items, skipped };
}

export function removeFromGallery(userId: string, itemId: string): boolean {
  const row = getDb()
    .query("SELECT character_id, image_id FROM character_gallery WHERE id = ? AND user_id = ?")
    .get(itemId, userId) as { character_id: string; image_id: string } | null;
  const item = getGalleryItem(userId, itemId);
  if (!item || !row) return false;
  const result = getDb()
    .query("DELETE FROM character_gallery WHERE id = ? AND user_id = ?")
    .run(itemId, userId);
  if (result.changes > 0) {
    const stillInGallery = getDb()
      .query("SELECT 1 AS found FROM character_gallery WHERE user_id = ? AND character_id = ? AND image_id = ? LIMIT 1")
      .get(userId, row.character_id, row.image_id);
    if (!stillInGallery) {
      const character = getCharacter(userId, row.character_id);
      const current = character?.extensions?.risu_asset_map;
      if (character && current && typeof current === "object" && !Array.isArray(current)) {
        const assetMap = Object.fromEntries(
          Object.entries(current).filter(([reference, imageId]) =>
            imageId !== row.image_id || !parseGalleryImageReference(reference)
          ),
        );
        const referenceNames = asStringMap(character.extensions?.[GALLERY_REFERENCE_NAMES_KEY]);
        const hadReferenceName = Object.hasOwn(referenceNames, row.image_id);
        delete referenceNames[row.image_id];
        if (Object.keys(assetMap).length !== Object.keys(current).length || hadReferenceName) {
          updateCharacter(userId, row.character_id, {
            extensions: {
              ...(character.extensions || {}),
              risu_asset_map: assetMap,
              [GALLERY_REFERENCE_NAMES_KEY]: referenceNames,
            },
          });
        }
      }
    }
    deleteImageIfUnreferenced(userId, item.image_id);
  }
  return result.changes > 0;
}

export async function getGalleryRemovalStatusAsync(userId: string, characterId: string, itemId: string): Promise<{ id: string; characterId: string; deleted: boolean } | null> {
  const row = await readDatabaseRow<{ id: string; characterId: string; deleted: number }>(`SELECT ? AS id, c.id AS characterId,
      NOT EXISTS (SELECT 1 FROM character_gallery g WHERE g.id = ? AND g.user_id = c.user_id AND g.character_id = c.id) AS deleted
    FROM characters c WHERE c.id = ? AND c.user_id = ?`, [itemId, itemId, characterId, userId]);
  return row ? { ...row, deleted: !!row.deleted } : null;
}

export async function removeFromGalleryAsync(userId: string, characterId: string, itemId: string): Promise<GalleryItemRemoval | null> {
  const result = await executeDatabaseOperation<{ id: string; characterId: string; imageId: string; character: any | null } | null>({ kind: 'gallery-remove', userId, characterId, itemId });
  if (!result) return null;
  const { character: row, ...removed } = result;
  const receipt: GalleryItemRemoval = { ...removed, status: 'completed' };
  // Gallery membership is committed now, even if another surface retains the image.
  eventBus.emit(EventType.CHARACTER_GALLERY_ITEM_REMOVED, receipt, userId);
  const character = row ? rowToCharacter(row) : null;
  if (character) eventBus.emit(EventType.CHARACTER_EDITED, { id: characterId, character }, userId);
  try {
    if (character && !collectCharacterImageIds(character).has(removed.imageId)) {
      const chats = await executeDatabaseOperation<any[]>({ kind: 'chat-clear-avatars', userId, ids: [removed.imageId] });
      for (const chat of chats) eventBus.emit(EventType.CHAT_CHANGED, { chat, changedFields: ['metadata.active_avatar_id', 'metadata.group_active_avatar_ids'] }, userId);
    }
    // One asynchronous reference scan replaces the old update + delete double scan.
    await deleteImageIfUnreferencedAsync(userId, removed.imageId);
  } catch (error) {
    console.error('[gallery] unused image cleanup failed:', error instanceof Error ? error.message : error);
  }
  return receipt;
}

export function updateCaption(
  userId: string,
  itemId: string,
  caption: string
): CharacterGalleryItem | null {
  const result = getDb()
    .query(
      "UPDATE character_gallery SET caption = ? WHERE id = ? AND user_id = ?"
    )
    .run(caption, itemId, userId);
  if (result.changes === 0) return null;
  return getGalleryItem(userId, itemId);
}

/**
 * Assign a friendly, portable `gallery://` name to one gallery image.
 * Previous references remain as local aliases so old chat messages keep
 * rendering, while card-owned content is rewritten to the new primary name.
 */
export function renameGalleryReference(
  userId: string,
  characterId: string,
  itemId: string,
  name: string,
): CharacterGalleryItem | null {
  const row = getDb()
    .query("SELECT id, character_id, image_id FROM character_gallery WHERE id = ? AND user_id = ?")
    .get(itemId, userId) as { id: string; character_id: string; image_id: string } | null;
  if (!row || row.character_id !== characterId) return null;

  let token: string;
  try {
    token = normalizeGalleryImageReferenceName(name);
  } catch (error) {
    throw new InvalidGalleryReferenceNameError(
      error instanceof Error ? error.message : "Invalid gallery reference name",
    );
  }
  const nextReference = createGalleryImageReference(token);

  // Ensure legacy gallery rows have a registered reference before renaming.
  registerGalleryReferences(userId, characterId, [{ id: row.id, image_id: row.image_id }]);
  const character = getCharacter(userId, characterId);
  if (!character) return null;
  const currentAssetMap = asStringMap(character.extensions?.risu_asset_map);
  const currentReferenceNames = asStringMap(character.extensions?.[GALLERY_REFERENCE_NAMES_KEY]);
  const currentReference = primaryGalleryReference(
    currentAssetMap,
    currentReferenceNames,
    row.image_id,
    row.id,
  );

  const conflictingImageId = currentAssetMap[nextReference];
  if (conflictingImageId && conflictingImageId !== row.image_id) {
    throw new GalleryReferenceConflictError();
  }
  if (currentReference === nextReference) {
    return getGalleryItem(userId, itemId);
  }

  const aliases = Object.entries(currentAssetMap)
    .filter(([reference, imageId]) => imageId === row.image_id && parseGalleryImageReference(reference))
    .map(([reference]) => reference);
  if (currentReference && !aliases.includes(currentReference)) aliases.push(currentReference);
  const legacyReference = createGalleryImageReference(row.id);
  if (!aliases.includes(legacyReference)) aliases.push(legacyReference);

  // Insert the new key first for older readers that do not understand the
  // explicit primary-reference metadata, then retain aliases for local chats.
  const assetMap: Record<string, string> = { [nextReference]: row.image_id };
  for (const [reference, imageId] of Object.entries(currentAssetMap)) {
    if (reference !== nextReference) assetMap[reference] = imageId;
  }
  const referenceNames = {
    ...currentReferenceNames,
    [row.image_id]: nextReference,
  };
  const replacements = new Map(aliases.map((reference) => [reference, nextReference]));
  const replacedExtensions = replaceGalleryReferencesDeep(character.extensions || {}, replacements) as Record<string, unknown>;
  const updates: Parameters<typeof updateCharacter>[2] = {
    extensions: {
      ...replacedExtensions,
      risu_asset_map: assetMap,
      [GALLERY_REFERENCE_NAMES_KEY]: referenceNames,
    },
  };
  const textFields = [
    "first_mes",
    "description",
    "personality",
    "scenario",
    "mes_example",
    "system_prompt",
    "post_history_instructions",
    "creator_notes",
  ] as const;
  for (const field of textFields) {
    const currentValue = character[field] || "";
    const nextValue = replaceGalleryReferences(currentValue, replacements);
    if (nextValue !== currentValue) updates[field] = nextValue;
  }
  const alternateGreetings = character.alternate_greetings || [];
  const nextAlternateGreetings = alternateGreetings.map((value) => replaceGalleryReferences(value, replacements));
  if (nextAlternateGreetings.some((value, index) => value !== alternateGreetings[index])) {
    updates.alternate_greetings = nextAlternateGreetings;
  }

  updateCharacter(userId, characterId, updates);
  return getGalleryItem(userId, itemId);
}

export function getGalleryItem(
  userId: string,
  itemId: string
): CharacterGalleryItem | null {
  const row = getDb()
    .query(
      `SELECT g.id, g.image_id, g.caption, g.sort_order, g.created_at,
              i.width, i.height, i.mime_type
       FROM character_gallery g
       JOIN images i ON i.id = g.image_id
       WHERE g.id = ? AND g.user_id = ?`
    )
    .get(itemId, userId) as any;

  if (!row) return null;
  const characterId = getDb()
    .query("SELECT character_id FROM character_gallery WHERE id = ? AND user_id = ?")
    .get(itemId, userId) as { character_id: string } | null;
  const character = characterId
    ? getCharacter(userId, characterId.character_id)
    : null;
  return rowToGalleryItem(
    row,
    asStringMap(character?.extensions?.risu_asset_map),
    asStringMap(character?.extensions?.[GALLERY_REFERENCE_NAMES_KEY]),
  );
}

// ── Image extraction from character data ──

const MD_IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g;
const HTML_IMG_RE = /<img[^>]+src=["']([^"']+)["']/gi;
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
const IMAGE_PATH_RE = /\.(?:apng|avif|bmp|gif|heic|heif|ico|jpe?g|jfif|pjp|pjpeg|png|svg|webp)$/i;

function trimTrailingUrlPunctuation(url: string): string {
  let trimmed = url.trim();

  while (/[.,!?;:]$/.test(trimmed)) {
    trimmed = trimmed.slice(0, -1);
  }

  while (trimmed.endsWith(")") && ((trimmed.match(/\(/g)?.length ?? 0) < (trimmed.match(/\)/g)?.length ?? 0))) {
    trimmed = trimmed.slice(0, -1);
  }

  while (trimmed.endsWith("]") && ((trimmed.match(/\[/g)?.length ?? 0) < (trimmed.match(/\]/g)?.length ?? 0))) {
    trimmed = trimmed.slice(0, -1);
  }

  return trimmed;
}

function isDirectImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return IMAGE_PATH_RE.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function extractImageUrls(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  let m: RegExpExecArray | null;

  const push = (url: string): void => {
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  };

  MD_IMAGE_RE.lastIndex = 0;
  while ((m = MD_IMAGE_RE.exec(text)) !== null) push(m[1]);

  HTML_IMG_RE.lastIndex = 0;
  while ((m = HTML_IMG_RE.exec(text)) !== null) push(m[1]);

  BARE_URL_RE.lastIndex = 0;
  while ((m = BARE_URL_RE.exec(text)) !== null) {
    const candidate = trimTrailingUrlPunctuation(m[0]);
    if (isDirectImageUrl(candidate)) push(candidate);
  }

  return urls;
}

function dataUriToFile(dataUri: string): File {
  const [header, base64] = dataUri.split(",", 2);
  const mime = header.match(/data:([^;]+)/)?.[1] || "image/png";
  const ext = mime.split("/")[1]?.replace("+xml", "") || "png";
  const buffer = Buffer.from(base64, "base64");
  return new File([buffer], `extracted.${ext}`, { type: mime });
}

async function fetchUrlAsFile(url: string): Promise<File> {
  const res = await safeFetch(url, { maxBytes: 50 * 1024 * 1024 });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const blob = await res.blob();
  if (blob.type && !blob.type.startsWith("image/")) {
    throw new Error(`Fetch did not return an image: ${blob.type}`);
  }
  const urlPath = new URL(url).pathname;
  const ext = urlPath.split(".").pop()?.split("?")[0] || "png";
  const name = `extracted.${ext}`;
  return new File([blob], name, { type: blob.type || "image/png" });
}

export async function extractImagesFromCharacter(
  userId: string,
  characterId: string
): Promise<CharacterGalleryItem[]> {
  const character = await getCharacterAsync(userId, characterId);
  if (!character) return [];

  const textFields = [
    character.first_mes,
    character.description,
    character.personality,
    character.scenario,
    character.mes_example,
    character.system_prompt,
    character.post_history_instructions,
    character.creator_notes,
    ...(character.alternate_greetings || []),
  ];

  if (character.extensions && Object.keys(character.extensions).length > 0) {
    textFields.push(JSON.stringify(character.extensions));
  }

  const seen = new Set<string>();
  const urls: string[] = [];
  for (const text of textFields) {
    if (!text) continue;
    for (const url of extractImageUrls(text)) {
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
  }

  if (urls.length === 0) return [];

  const items: CharacterGalleryItem[] = [];
  for (const url of urls) {
    try {
      let file: File;
      if (url.startsWith("data:")) {
        file = dataUriToFile(url);
      } else if (url.startsWith("http://") || url.startsWith("https://")) {
        file = await fetchUrlAsFile(url);
      } else {
        continue; // skip relative or unrecognised URLs
      }
      const item = await uploadToGallery(userId, characterId, file);
      items.push(item);
    } catch {
      // skip images that fail to download/convert
    }
  }

  return items;
}
