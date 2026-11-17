import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { closeDatabase, getDb, initDatabase } from '../db/connection';
import { bootstrapRoutes } from '../routes/bootstrap.routes';
import { getStartupSettings } from './bootstrap.service';

beforeEach(() => {
  closeDatabase();
  initDatabase(':memory:');
  getDb().run('CREATE TABLE settings (user_id TEXT, key TEXT, value TEXT, updated_at INTEGER DEFAULT 0)');
});
afterEach(closeDatabase);

const theme = { id: 'saved-theme', mode: 'dark' };
const customCSS = { css: 'body { color: red }', enabled: true, revision: 3, bundleId: 'bundle-a' };
const componentOverrides = { InputArea: { css: '.input { padding: 20px }', tsx: '<div />', enabled: true } };

function seed(userId: string) {
  for (const [key, value] of Object.entries({ theme, customCSS, componentOverrides })) {
    getDb().run('INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)', [userId, key, JSON.stringify(value)]);
  }
}

test('startup delivers the complete theme pack in one account-scoped snapshot', () => {
  seed('a');
  expect(getStartupSettings('a')).toMatchObject({ theme, customCSS, componentOverrides });
  expect(getStartupSettings('b')).toEqual({});
});

test('startup route serves appearance without needing any broader bootstrap tables', async () => {
  seed('a');
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('userId', 'a'); await next(); });
  app.route('/bootstrap', bootstrapRoutes);
  const response = await app.request('/bootstrap/startup');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ theme, customCSS, componentOverrides });
});
