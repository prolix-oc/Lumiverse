import { afterEach, beforeEach, expect, test } from 'bun:test';
import { closeDatabase, getDb, initDatabase } from '../db/connection';
import { getConnectionOrganization, watchUserConnectionOrganization } from './connection-organization.service';
import { putSetting } from './settings.service';
import { eventBus } from '../ws/bus';
import { EventType } from '../ws/events';
import { Hono } from 'hono';
import { connectionsRoutes as routes } from '../routes/connections.routes';

beforeEach(async () => {
  closeDatabase(); initDatabase(':memory:');
  getDb().run('PRAGMA foreign_keys = OFF');
  getDb().run(await Bun.file(new URL('../db/baseline.sql', import.meta.url)).text());
  for (const table of ['connection_profiles', 'image_gen_connections', 'tts_connections', 'stt_connections', 'decision_connections']) {
    for (const [id, userId] of [['a', 'alice'], ['b', 'alice'], ['secret', 'bob']]) {
      getDb().query(`INSERT INTO ${table} (id,user_id,name,provider,model,api_url,metadata,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, userId, id, 'openai', 'test', 'https://private.invalid', '{"secret":"private"}', 1, 1);
    }
  }
});
afterEach(() => closeDatabase());

test('all SQL kinds are scoped, ordered, redacted and include empty folders', () => {
  for (const kind of ['llm', 'image', 'tts', 'stt', 'decision'] as const) {
    const key = kind === 'image' ? 'imageGen' : kind;
    putSetting('alice', 'connectionLibraries', { [key]: { folders: [{ id: 'f', name: 'Work' }, { id: 'e', name: 'Empty' }],
      folderOrder: ['e', 'f', ''], assignments: { b: 'f', secret: 'f' } } });
    putSetting('alice', 'connectionsOrder', { [key]: ['b', 'secret', 'a', 'b'] });
    putSetting('alice', 'recentConnections', { [key]: ['b', 'deleted', 'a'] });
    const result = getConnectionOrganization('alice', kind);
    expect(result.connections.map(p => p.id)).toEqual(['b', 'a']);
    expect(result.folders).toEqual([{ id: 'e', name: 'Empty', connectionIds: [] }, { id: 'f', name: 'Work', connectionIds: ['b'] }, { id: null, name: null, connectionIds: ['a'] }]);
    expect(result.recentConnectionIds).toEqual(['b', 'a']);
    expect(JSON.stringify(result)).not.toContain('private');
    expect(result.revision).toBe(getConnectionOrganization('alice', kind).revision);
  }
});

test('revision changes for same-second edits, but not unrelated settings or other users', () => {
  const initial = getConnectionOrganization('alice', 'llm').revision;
  putSetting('bob', 'activeProfileId', 'secret');
  putSetting('alice', 'theme', 'dark');
  expect(getConnectionOrganization('alice', 'llm').revision).toBe(initial);
  putSetting('alice', 'activeProfileId', 'a');
  expect(getConnectionOrganization('alice', 'llm').revision).not.toBe(initial);
});

test('get route validates kind and uses authenticated user, ignoring caller userId', async () => {
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('userId', 'alice'); await next(); }); app.route('/', routes);
  const response = await app.request('/organization/llm?userId=bob');
  expect(response.status).toBe(200);
  expect((await response.json()).connections.map((p: any) => p.id)).toEqual(['a', 'b']);
  expect((await app.request('/organization/nope')).status).toBe(400);
});

test('native edit route commits atomically and returns scoped conflict errors', async () => {
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('userId', 'alice'); await next(); }); app.route('/', routes);
  const edit = (body: unknown) => app.request('/organization/edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect((await edit([{ kind: 'llm', action: 'create', id: 'f', name: 'Folder', userId: 'bob' }])).status).toBe(200);
  expect(getConnectionOrganization('alice', 'llm').folders[0].id).toBe('f');
  expect(getConnectionOrganization('bob', 'llm').folders).toHaveLength(1);
  expect((await edit([{ kind: 'llm', action: 'rename', id: 'f', name: 'New', previous: 'wrong' }])).status).toBe(409);
  expect((await edit([{ kind: 'unknown', action: 'create' }])).status).toBe(400);
  expect((await app.request('/organization')).status).toBe(200);
});

test('watch delivers initial state, deduplicates and stops before pending delivery', async () => {
  const received: string[] = [];
  const stop = watchUserConnectionOrganization('alice', 'llm', snapshot => received.push(snapshot.revision));
  await Bun.sleep(25);
  expect(received).toHaveLength(1);
  putSetting('alice', 'activeProfileId', 'a');
  await Bun.sleep(25);
  expect(received).toHaveLength(2);
  eventBus.emit(EventType.CONNECTION_PROFILE_LOADED, {}, 'bob');
  await Bun.sleep(25);
  expect(received).toHaveLength(2);
  stop(); putSetting('alice', 'activeProfileId', 'b'); await Bun.sleep(25);
  expect(received).toHaveLength(2);
});

test('embedding reads perform the existing legacy migration once and retain stable IDs', () => {
  putSetting('alice', 'embeddingConfig', { enabled: true, provider: 'openai', model: 'legacy' });
  const first = getConnectionOrganization('alice', 'embedding');
  const before = getDb().query('SELECT * FROM settings').all();
  expect(first.connections).toHaveLength(1);
  expect(first.connections[0].model).toBe('legacy');
  expect(getConnectionOrganization('alice', 'embedding')).toEqual(first);
  expect(getDb().query('SELECT * FROM settings').all()).toEqual(before);
});

test('import completion refreshes snapshots even without per-profile events', async () => {
  let last = getConnectionOrganization('alice', 'llm');
  const stop = watchUserConnectionOrganization('alice', 'llm', value => { last = value; });
  await Bun.sleep(25);
  getDb().query('INSERT INTO connection_profiles (id,user_id,name,provider) VALUES (?,?,?,?)').run('imported', 'alice', 'Imported', 'openai');
  eventBus.emit(EventType.USER_IMPORT_COMPLETE, { jobId: 'import' }, 'alice');
  await Bun.sleep(25); expect(last.connections.some(profile => profile.id === 'imported')).toBe(true); stop();
});

test('inherited embedding profiles use caller folders and owner edits invalidate the caller watch', async () => {
  getDb().query('INSERT INTO user (id,name,email,createdAt) VALUES (?,?,?,?)').run('owner', 'Owner', 'owner@example.test', 1);
  const profile = { id: '12345678-1234-4234-8234-123456789abc', name: 'Shared', provider: 'openai', model: 'model', api_key: 'do-not-expose', enabled: true };
  putSetting('owner', 'embeddingConfig', { enabled: true, primaryProfileId: '12345678-1234-4234-8234-123456789abc', connectionProfiles: [profile] });
  putSetting('owner', 'connectionLibraries', { embedding: { folders: [{ id: 'private', name: 'Owner private' }], folderOrder: ['private'], assignments: { '12345678-1234-4234-8234-123456789abc': 'private' } } });
  putSetting('alice', 'connectionLibraries', { embedding: { folders: [{ id: 'mine', name: 'My folder' }], folderOrder: ['mine'], assignments: { '12345678-1234-4234-8234-123456789abc': 'mine' } } });
  const snapshots: any[] = [];
  const stop = watchUserConnectionOrganization('alice', 'embedding', value => snapshots.push(value));
  await Bun.sleep(25);
  expect(snapshots[0].folders[0]).toEqual({ id: 'mine', name: 'My folder', connectionIds: ['12345678-1234-4234-8234-123456789abc'] });
  expect(JSON.stringify(snapshots)).not.toContain('private'); expect(JSON.stringify(snapshots)).not.toContain('do-not-expose');
  putSetting('owner', 'embeddingConfig', { enabled: true, primaryProfileId: '12345678-1234-4234-8234-123456789abc', connectionProfiles: [{ ...profile, name: 'Changed' }] });
  await Bun.sleep(25); expect(snapshots.at(-1).connections[0].name).toBe('Changed'); stop();
});
