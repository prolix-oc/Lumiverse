import { afterAll, beforeAll, expect, test } from 'bun:test';
import { closeDatabase, getDb, initDatabase } from '../db/connection';
import { createConnection, updateConnection, getFallbackConnection, getConnection, deleteConnection } from './connections.service';

beforeAll(async () => {
  closeDatabase();
  initDatabase(':memory:');
  getDb().run('PRAGMA foreign_keys = OFF');
  getDb().run(await Bun.file(new URL('../db/baseline.sql', import.meta.url)).text());
});
afterAll(() => closeDatabase());
const make = (userId: string, provider = 'openai') => createConnection(userId, { name: 'Test', provider, model: 'model' });

test('persists and clears a fallback without changing the default', async () => {
  const primary = await make('owner');
  const fallback = await make('owner');
  const updated = await updateConnection('owner', primary.id, { metadata: { fallback_connection_id: fallback.id, custom: true } });
  expect(getFallbackConnection('owner', updated!)?.id).toBe(fallback.id);
  expect(getConnection('owner', primary.id)?.metadata.custom).toBe(true);
  expect(updated?.is_default).toBe(false);
  const cleared = await updateConnection('owner', primary.id, { metadata: { fallback_connection_id: null } });
  expect(getFallbackConnection('owner', cleared!)).toBeNull();
});
test('rejects self, missing, foreign and roulette targets', async () => {
  const source = await make('owner');
  const foreign = await make('other');
  const roulette = await make('owner', 'model_roulette');
  for (const id of [source.id, 'missing', foreign.id, roulette.id, 123]) {
    await expect(updateConnection('owner', source.id, { metadata: { fallback_connection_id: id } })).rejects.toThrow();
    expect(getConnection('owner', source.id)?.metadata.fallback_connection_id).toBeUndefined();
  }
});
test('a deleted fallback leaves the source usable and resolves to null', async () => {
  const fallback = await make('owner');
  const primary = await createConnection('owner', { name: 'Primary', provider: 'openai', metadata: { fallback_connection_id: fallback.id } });
  await deleteConnection('owner', fallback.id);
  expect(getConnection('owner', primary.id)).not.toBeNull();
  expect(getFallbackConnection('owner', primary)).toBeNull();
});
