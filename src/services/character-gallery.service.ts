import { getDb } from "../db/connection";
import { uploadImage } from "./images.service";
import { getCharacter } from "./characters.service";
import type { CharacterGalleryItem } from "../types/character-gallery";
import { safeFetch } from "../utils/safe-fetch";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

function rowToGalleryItem(row: any): CharacterGalleryItem {
  return {
    id: row.id,
    image_id: row.image_id,
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
  characterId: string
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

  return rows.map(rowToGalleryItem);
}

export function addToGallery(
  userId: string,
  characterId: string,
  imageId: string,
  caption?: string
): CharacterGalleryItem {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  getDb()
    .query(
      `INSERT INTO character_gallery (id, user_id, character_id, image_id, caption, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, userId, characterId, imageId, caption ?? "", 0, now);

  return getGalleryItem(userId, id)!;
}

export async function uploadToGallery(
  userId: string,
  characterId: string,
  file: File,
  caption?: string
): Promise<CharacterGalleryItem> {
  const image = await uploadImage(userId, file);
  return addToGallery(userId, characterId, image.id, caption);
}

/**
 * Upload multiple images to a character's gallery in one call.
 * Emits IMPORT_GALLERY_PROGRESS WS events so the frontend can track progress.
 */
export async function uploadBulkToGallery(
  userId: string,
  characterId: string,
  files: File[],
): Promise<CharacterGalleryItem[]> {
  const total = files.length;
  const items: CharacterGalleryItem[] = [];

  for (let i = 0; i < total; i++) {
    eventBus.emit(
      EventType.IMPORT_GALLERY_PROGRESS,
      { characterId, current: i + 1, total, filename: files[i].name },
      userId,
    );
    try {
      const item = await uploadToGallery(userId, characterId, files[i]);
      items.push(item);
    } catch {
      // skip individual failures
    }
  }

  return items;
}

export function removeFromGallery(userId: string, itemId: string): boolean {
  const result = getDb()
    .query("DELETE FROM character_gallery WHERE id = ? AND user_id = ?")
    .run(itemId, userId);
  return result.changes > 0;
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

function getGalleryItem(
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

  return row ? rowToGalleryItem(row) : null;
}

// ── Image extraction from character data ──

const MD_IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g;
const HTML_IMG_RE = /<img[^>]+src=["']([^"']+)["']/gi;

function extractImageUrls(text: string): string[] {
  const urls: string[] = [];
  let m: RegExpExecArray | null;

  MD_IMAGE_RE.lastIndex = 0;
  while ((m = MD_IMAGE_RE.exec(text)) !== null) urls.push(m[1]);

  HTML_IMG_RE.lastIndex = 0;
  while ((m = HTML_IMG_RE.exec(text)) !== null) urls.push(m[1]);

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
  const urlPath = new URL(url).pathname;
  const ext = urlPath.split(".").pop()?.split("?")[0] || "png";
  const name = `extracted.${ext}`;
  return new File([blob], name, { type: blob.type || "image/png" });
}

export async function extractImagesFromCharacter(
  userId: string,
  characterId: string
): Promise<CharacterGalleryItem[]> {
  const character = getCharacter(userId, characterId);
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
