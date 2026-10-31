import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { closeDatabase, getDb, initDatabase } from '../db/connection';
import { presetProfilesRoutes } from './preset-profiles.routes';

const app = new Hono();
app.use('*', async (c, next) => { c.set('userId', c.req.header('x-test-user') ?? 'u1'); await next(); });
app.route('/', presetProfilesRoutes);
beforeEach(() => {
  closeDatabase(); initDatabase(':memory:');
  getDb().run("CREATE TABLE settings (user_id TEXT, key TEXT, value TEXT, updated_at INTEGER DEFAULT 0, PRIMARY KEY(user_id, key))");
  getDb().run("CREATE TABLE presets (id TEXT, user_id TEXT)");
  getDb().run("INSERT INTO presets VALUES ('p', 'u1')");
  const binding = JSON.stringify({ preset_id: 'p', block_states: { b: true }, captured_at: 1 });
  for (const key of ['presetProfileDefaults:p', 'presetProfile:chat:chat', 'presetProfile:persona:persona', 'presetProfile:character:character', 'presetProfile:connection:connection']) {
    getDb().run('INSERT INTO settings (user_id,key,value) VALUES (?,?,?)', ['u1', key, binding]);
  }
});
afterEach(closeDatabase);

const query = 'preset_id=p&chat_id=chat&persona_id=persona&character_id=character&connection_id=connection';
test('one context response matches all five independently scoped snapshots', async () => {
  const context = await (await app.request('/context?' + query)).json();
  for (const [key, path] of Object.entries({ defaults: '/defaults?preset_id=p', chat: '/chat/chat', persona: '/persona/persona', character: '/character/character', connection: '/connection/connection' })) {
    expect(context[key]).toEqual(await (await app.request(path)).json());
  }
  const grouped = await (await app.request('/context?' + query + '&is_group=true')).json();
  expect(grouped.character).toBeNull();
  expect(grouped.chat).toEqual(context.chat);
});
test('missing bindings and another account return null without leaking snapshots', async () => {
  const context = await (await app.request('/context?' + query, { headers: { 'x-test-user': 'u2' } })).json();
  for (const key of ['defaults', 'chat', 'persona', 'character', 'connection']) expect(context[key]).toBeNull();
});
test('a broken section does not prevent other snapshots from loading', async () => {
  getDb().run("UPDATE settings SET value = '{broken' WHERE key = 'presetProfileDefaults:p'");
  const response = await app.request('/context?' + query);
  expect(response.status).toBe(200);
  const context = await response.json();
  expect(context.defaults).toBeNull();
  expect(context.errors).toEqual({ defaults: 'unavailable' });
  expect(context.chat.preset_id).toBe('p');
  expect(context.connection.preset_id).toBe('p');
});
