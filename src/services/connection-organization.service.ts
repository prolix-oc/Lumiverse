import { createHash } from 'node:crypto';
import { getDb } from '../db/connection';
import { embeddingOrganizationProfiles, prepareEmbeddingOrganization } from './embeddings.service';
import { eventBus } from '../ws/bus';
import { EventType } from '../ws/events';
import { assertOrganizationKind, projectConnectionOrganization, watchConnectionOrganization, organizationInvalidated,
  type ConnectionOrganizationKind, type ConnectionOrganizationSnapshot } from '../shared/connection-organization';
import type { SpindleConnectionProfileSummary } from 'lumiverse-spindle-types';

const tables = { llm: 'connection_profiles', image: 'image_gen_connections', tts: 'tts_connections',
  stt: 'stt_connections', decision: 'decision_connections' } as const;
export const ORGANIZATION_SETTING_KEYS = ['connectionLibraries', 'connectionsOrder', 'recentConnections',
  'connectionsPickerSettings', 'activeProfileId', 'imageGeneration', 'voiceSettings'] as const;

export function getConnectionOrganization(userId: string, kind: ConnectionOrganizationKind): ConnectionOrganizationSnapshot {
  assertOrganizationKind(kind);
  if (!userId) throw Object.assign(new Error('A user context is required'), { code: 'USER_CONTEXT_REQUIRED' });
  if (kind === 'embedding') prepareEmbeddingOrganization(userId);
  return getDb().transaction(() => {
    const settings: Record<string, any> = {};
    for (const key of ORGANIZATION_SETTING_KEYS) {
      const row = getDb().query('SELECT value FROM settings WHERE user_id = ? AND key = ?').get(userId, key) as { value: string } | null;
      if (row) settings[key] = JSON.parse(row.value);
    }
    let profiles: SpindleConnectionProfileSummary[];
    if (kind === 'embedding') profiles = embeddingOrganizationProfiles(userId);
    else {
      const rows = getDb().query(`SELECT id, name, provider, model, is_default${kind === 'tts' ? ', voice' : ''}
        FROM ${tables[kind]} WHERE user_id = ? ORDER BY updated_at DESC, id`).all(userId) as Array<{
          id: string; name: string; provider: string; model: string; is_default: number; voice?: string;
        }>;
      const activeId = kind === 'llm' ? settings.activeProfileId
        : kind === 'image' ? rows.find(row => row.id === settings.imageGeneration?.activeImageGenConnectionId)?.id ?? rows.find(row => row.is_default)?.id
        : kind === 'tts' ? settings.voiceSettings?.ttsConnectionId || rows.find(row => row.is_default)?.id
        : kind === 'stt' ? settings.voiceSettings?.sttConnectionId : rows.find(row => row.is_default)?.id;
      profiles = rows.map(row => ({ id: row.id, kind, name: row.name || row.provider, provider: row.provider,
        model: row.model || '', active: row.id === activeId, ...(kind === 'tts' ? { voice: row.voice || '' } : {}) }));
    }
    const snapshot = projectConnectionOrganization(kind, profiles, settings);
    return { ...snapshot, revision: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
  })();
}

export const ORGANIZATION_EVENTS = [EventType.USER_IMPORT_COMPLETE, EventType.SETTINGS_UPDATED, EventType.CONNECTION_PROFILE_LOADED,
  EventType.CONNECTION_ORGANIZATION_CHANGED,
  EventType.IMAGE_GEN_CONNECTION_CHANGED, EventType.TTS_CONNECTION_CHANGED,
  EventType.STT_CONNECTION_CHANGED, EventType.DECISION_CONNECTION_CHANGED] as const;

// An owner embedding edit can change every user's effective profiles. Broadcast only an
// invalidation, never the owner's configuration, identity, or folder information.
eventBus.on(EventType.SETTINGS_UPDATED, event => {
  const keys = event.payload?.keys ?? [event.payload?.key];
  if (keys.includes('embeddingConfig')) eventBus.emit(EventType.CONNECTION_ORGANIZATION_CHANGED, { kind: 'embedding' });
});
eventBus.on(EventType.USER_IMPORT_COMPLETE, () => {
  eventBus.emit(EventType.CONNECTION_ORGANIZATION_CHANGED, { kind: 'embedding' });
});

export function watchUserConnectionOrganization(userId: string, kind: ConnectionOrganizationKind,
  handler: (snapshot: ConnectionOrganizationSnapshot) => void, onError?: (error: Error) => void): () => void {
  assertOrganizationKind(kind);
  return watchConnectionOrganization(async () => getConnectionOrganization(userId, kind), refresh => {
    const removers = ORGANIZATION_EVENTS.map(type => eventBus.on(type, event => {
      // Embeddings can be inherited from the owner, but the projection always uses the caller's folders.
      if ((event.userId === userId || (kind === 'embedding' && event.payload?.kind === 'embedding' && !event.userId))
        && organizationInvalidated(kind, type, event.payload)) refresh();
    }));
    return () => removers.forEach(remove => remove());
  }, handler, onError);
}
