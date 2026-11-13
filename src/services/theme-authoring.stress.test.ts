import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, initDatabase, getDb } from '../db/connection';
import { env } from '../env';
import { runThemeAuthoring } from './theme-authoring.service';
import { ThemeAuthoringHost } from '../spindle/theme-authoring-host';

const directory = mkdtempSync(join(tmpdir(), 'spindle-stress-'));
const database = join(directory, 'test.db');
const previousData = env.dataDir;
env.dataDir = directory;
initDatabase(database);
getDb().run(
  'CREATE TABLE settings (user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id,key))',
);
getDb().run(
  'CREATE TABLE theme_assets (id TEXT PRIMARY KEY, user_id TEXT, bundle_id TEXT, slug TEXT, storage_type TEXT, image_id TEXT, file_name TEXT, original_filename TEXT, mime_type TEXT, byte_size INTEGER, tags_json TEXT, metadata_json TEXT, created_at INTEGER, updated_at INTEGER, UNIQUE(user_id,bundle_id,slug))',
);
afterAll(() => {
  closeDatabase();
  env.dataDir = previousData;
  rmSync(directory, { recursive: true, force: true });
});
const state = (user: string): Promise<any> => runThemeAuthoring(user, 'state');

test('1000 concurrent writers across 250 users commit one winner per revision', async () => {
  const users = Array.from({ length: 250 }, (_, i) => `user-${i}`);
  const initial = await Promise.all(users.map(state));
  const start = performance.now();
  const results = await Promise.all(
    users.map(async (user, i) => {
      const writes = await Promise.allSettled(
        Array.from({ length: 4 }, (_, j) =>
          runThemeAuthoring(user, 'install', {
            draft: { name: `Draft ${j}`, globalCSS: `body{--owner: "${user}";--winner:${j}}` },
            options: { expectedRevision: initial[i].revision },
          }),
        ),
      );
      expect(writes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of writes)
        if (r.status === 'rejected') expect(r.reason.message).toContain('THEME_CONFLICT');
      const current = await state(user);
      expect(current.backups).toHaveLength(1);
      expect(current.customCSS.css).toContain(`"${user}"`);
      return current.revision;
    }),
  );
  console.log(
    JSON.stringify({
      scenario: '1000-writers-250-users',
      ms: performance.now() - start,
      rssMiB: process.memoryUsage().rss / 1048576,
    }),
  );
  closeDatabase();
  initDatabase(database);
  for (let i = 0; i < users.length; i++) expect((await state(users[i])).revision).toBe(results[i]);
}, 30000);

test('10000 scoped state requests stay responsive in bounded batches', async () => {
  const times: number[] = [];
  const start = performance.now();
  for (let offset = 0; offset < 10000; offset += 100) {
    await Promise.all(
      Array.from({ length: 100 }, async (_, j) => {
        const began = performance.now();
        const current = await state(`user-${(offset + j) % 250}`);
        expect(current.customCSS.css).toContain(`"user-${(offset + j) % 250}"`);
        times.push(performance.now() - began);
      }),
    );
    await Bun.sleep(0);
  }
  times.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      scenario: '10000-reads-batches100',
      ms: performance.now() - start,
      p95ms: times[Math.floor(times.length * 0.95)],
      rssMiB: process.memoryUsage().rss / 1048576,
    }),
  );
}, 30000);

test('host rejects malformed and cross-user requests while concurrent revocations prevent all commits', async () => {
  const replies: any[] = [];
  let allowed = true;
  const host = new ThemeAuthoringHost({
    resolveUser(user) {
      if (user !== 'scoped') throw new Error('scope denied');
      return user;
    },
    canMutate: () => allowed,
    post: (r) => {
      replies.push(r);
    },
  });
  const initial = await state('scoped');
  const pending = Array.from({ length: 100 }, (_, i) =>
    host.handle({
      type: 'theme_authoring',
      userId: 'scoped',
      requestId: `revoke-${i}`,
      input: {
        operation: 'install',
        args: {
          draft: { name: `Draft ${i}`, globalCSS: 'body{color:red}' },
          options: { expectedRevision: initial.revision },
        },
      },
    }),
  );
  allowed = false;
  await Promise.all(pending);
  expect(replies).toHaveLength(100);
  expect(replies.every((r) => r.error?.includes('app_manipulation'))).toBe(true);
  expect((await state('scoped')).revision).toBe(initial.revision);
  const invalid: any[] = [
    null,
    [],
    0,
    'x',
    { operation: '__proto__' },
    { operation: 'constructor' },
    { operation: 'state', args: { extra: true } },
    { operation: 'asset_update', args: { patch: [] } },
    { operation: 'install', args: { draft: null } },
  ];
  await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      host.handle({
        type: 'theme_authoring',
        requestId: `invalid-${i}`,
        userId: 'scoped',
        input: invalid[i % invalid.length],
      }),
    ),
  );
  await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      host.handle({
        type: 'theme_authoring',
        requestId: `scope-${i}`,
        userId: `user-${i}`,
        input: { operation: 'state', args: {} },
      }),
    ),
  );
  expect(replies).toHaveLength(300);
  expect(new Set(replies.map((r) => r.requestId)).size).toBe(300);
  expect(replies.every((r) => r.error)).toBe(true);
  host.dispose();
});

test('measure admitted large stylesheet validation cost without committing', async () => {
  const css = Array.from(
    { length: 12000 },
    (_, i) => `.c${i}{color:rgb(1,2,3);padding:4px;margin:2px}`,
  ).join('\n');
  const start = performance.now();
  let timerAt = 0;
  const timer = new Promise<void>((resolve) =>
    setTimeout(() => {
      timerAt = performance.now();
      resolve();
    }, 0),
  );
  await runThemeAuthoring('stress-css', 'validate', { draft: { name: 'Large', globalCSS: css } });
  await timer;
  console.log(
    JSON.stringify({
      scenario: 'large-css-validation',
      bytes: css.length,
      ms: performance.now() - start,
      timerDelayMs: timerAt - start,
      rssMiB: process.memoryUsage().rss / 1048576,
    }),
  );
}, 30000);
