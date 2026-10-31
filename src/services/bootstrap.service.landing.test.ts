import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { closeDatabase, getDb, initDatabase } from '../db/connection';
import { buildLandingBootstrapPayload } from './bootstrap.service';

beforeEach(() => {
  closeDatabase(); initDatabase(':memory:');
  const db = getDb();
  db.run("CREATE TABLE settings (user_id TEXT, key TEXT, value TEXT, updated_at INTEGER DEFAULT 0)");
  db.run("CREATE TABLE characters (id TEXT, name TEXT, avatar_path TEXT, image_id TEXT, extensions TEXT)");
  db.run("CREATE TABLE chats (id TEXT, user_id TEXT, character_id TEXT, name TEXT, metadata TEXT, created_at INTEGER, updated_at INTEGER)");
  db.run("INSERT INTO settings VALUES ('u', 'favorites', '[\"b\"]', 0), ('u', 'landingHiddenCharacterIds', '[\"a\"]', 0), ('u', 'landingPageChatsDisplayed', '1', 0)");
  for (const id of ['a', 'b', 'c']) {
    db.run("INSERT INTO characters VALUES (?, ?, NULL, NULL, '{}')", [id, id]);
    db.run("INSERT INTO chats VALUES (?, 'u', ?, ?, '{}', 1, 1)", [id, id, id]);
  }
});
afterEach(closeDatabase);

test('landing reuses startup preferences while preserving totals, exclusions and favorites', () => {
  const query = spyOn(getDb(), 'query');
  try {
    const { payload, errors } = buildLandingBootstrapPayload('u');
    expect(errors).toEqual({});
    expect(payload.recentChats.total).toBe(2);
    expect(payload.recentChats.data.map(item => item.character_id)).toEqual(['b']);
    expect(query.mock.calls.filter(([sql]) => /FROM settings/.test(sql))).toHaveLength(1);
  } finally { query.mockRestore(); }
});

test('a malformed unrelated startup preference keeps the independent recent-list fallback', () => {
  getDb().run("INSERT INTO settings VALUES ('u', 'activeProfileId', '{broken', 0)");
  const { payload, errors } = buildLandingBootstrapPayload('u');
  expect(errors.startupSettings).toBeString();
  expect(errors.recentChats).toBeUndefined();
  expect(payload.recentChats.data.map(item => item.character_id)).toEqual(['b']);
  expect(payload.recentChats.total).toBe(2);
});
