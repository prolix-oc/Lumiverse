import type { Database } from 'bun:sqlite';
import { updateCharacterRowWithDb } from './character-operations';
import { parseGalleryImageReference } from '../utils/gallery-image-reference';

export const GALLERY_REFERENCE_NAMES_KEY = 'gallery_reference_names';

/** Remove the relationship and its last gallery aliases in one transaction. */
export function removeGalleryItemWithDb(db: Database, userId: string, characterId: string, itemId: string):
  { id: string; characterId: string; imageId: string; character: any | null } | null {
  return db.transaction(() => {
    const row = db.query(`SELECT g.image_id FROM character_gallery g
      JOIN characters c ON c.id = g.character_id AND c.user_id = g.user_id
      WHERE g.id = ? AND g.user_id = ? AND g.character_id = ?`).get(itemId, userId, characterId) as { image_id: string } | null;
    if (!row) return null;
    db.query('DELETE FROM character_gallery WHERE id = ? AND user_id = ? AND character_id = ?').run(itemId, userId, characterId);
    let character: any | null = null;
    if (!db.query('SELECT 1 FROM character_gallery WHERE user_id = ? AND character_id = ? AND image_id = ? LIMIT 1').get(userId, characterId, row.image_id)) {
      const owner = db.query('SELECT extensions FROM characters WHERE id = ? AND user_id = ?').get(characterId, userId) as { extensions: string };
      const extensions = JSON.parse(owner.extensions || '{}');
      const current = extensions.risu_asset_map;
      if (current && typeof current === 'object' && !Array.isArray(current)) {
        const assetMap = Object.fromEntries(Object.entries(current).filter(([reference, id]) => id !== row.image_id || !parseGalleryImageReference(reference)));
        const names = extensions[GALLERY_REFERENCE_NAMES_KEY];
        const referenceNames = names && typeof names === 'object' && !Array.isArray(names) ? { ...names } : {};
        const hadName = Object.hasOwn(referenceNames, row.image_id);
        delete referenceNames[row.image_id];
        if (Object.keys(assetMap).length !== Object.keys(current).length || hadName) {
          character = updateCharacterRowWithDb(db, userId, characterId, {
            extensions: { ...extensions, risu_asset_map: assetMap, [GALLERY_REFERENCE_NAMES_KEY]: referenceNames },
          })!.after;
        }
      }
    }
    return { id: itemId, characterId, imageId: row.image_id, character };
  }).immediate();
}
