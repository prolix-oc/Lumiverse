import type { Database } from "bun:sqlite";
import { worldBookVectorDesiredStatusSql, worldBookVectorSettingsFingerprint } from "../services/world-book-vector-state";
import { WORLD_BOOK_VECTOR_SETTINGS_KEY } from "../services/world-book-vector-constants";
import { normalizeWorldBookVectorSettings } from "../services/world-book-vector-settings-model";

function vectorSettingsChanged(previousJson: string | undefined, nextJson: string): boolean {
  try {
    const previous = normalizeWorldBookVectorSettings(previousJson === undefined ? null : JSON.parse(previousJson));
    const next = normalizeWorldBookVectorSettings(JSON.parse(nextJson));
    return worldBookVectorSettingsFingerprint(previous) !== worldBookVectorSettingsFingerprint(next);
  } catch { return true; }
}

/** Save settings and invalidate dependent vectors in the same transaction. */
export function putSettingsWithDb(db: Database, userId: string, entries: Array<{ key: string; json: string }>, updatedAt: number): void {
  db.transaction(() => {
    const vectorEntry = entries.find((entry) => entry.key === WORLD_BOOK_VECTOR_SETTINGS_KEY);
    const previous = vectorEntry ? db.query("SELECT value FROM settings WHERE key = ? AND user_id = ?").get(vectorEntry.key, userId) as { value: string } | null : null;
    for (const entry of entries) db.query(`INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(entry.key, entry.json, userId, updatedAt);
    if (vectorEntry && vectorSettingsChanged(previous?.value, vectorEntry.json)) {
      db.query(`UPDATE world_book_entries SET vector_index_status = ${worldBookVectorDesiredStatusSql()}, vector_indexed_at = NULL, vector_index_error = NULL
        WHERE world_book_id IN (SELECT id FROM world_books WHERE user_id = ?)`).run(userId);
    }
  }).immediate();
}
