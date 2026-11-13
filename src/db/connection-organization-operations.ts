import type { Database } from 'bun:sqlite';
import { applyOrganizationEdits, validateOrganizationEdits, ORGANIZATION_KEYS, type OrganizationEdit } from '../shared/connection-organization-edits';
import { putSettingsWithDb } from './settings-operations';

export function editConnectionOrganizationWithDb(db: Database, userId: string, edits: OrganizationEdit[]) {
  validateOrganizationEdits(edits);
  return db.transaction(() => {
    const settings: Record<string, unknown> = {};
    for (const key of [...ORGANIZATION_KEYS, 'connectionsPickerSettings']) {
      const row = db.query('SELECT value FROM settings WHERE user_id = ? AND key = ?').get(userId, key) as { value: string } | null;
      if (row) settings[key] = JSON.parse(row.value);
    }
    const next = applyOrganizationEdits(settings, edits);
    const entries = ORGANIZATION_KEYS.filter(key => JSON.stringify(settings[key]) !== JSON.stringify(next[key]))
      .map(key => ({ key, json: JSON.stringify(next[key]) }));
    if (entries.some(entry => Buffer.byteLength(entry.json) > 2 * 1024 * 1024)) {
      throw Object.assign(new Error('Organization settings exceed 2 MiB'), { code: 'CONNECTION_ORGANIZATION_INVALID' });
    }
    putSettingsWithDb(db, userId, entries, Math.floor(Date.now() / 1000));
    return Object.fromEntries(ORGANIZATION_KEYS.map(key => [key, next[key] ?? {}]));
  }).immediate();
}
