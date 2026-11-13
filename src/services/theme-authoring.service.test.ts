import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { closeDatabase, initDatabase, getDb } from '../db/connection';
import { env } from '../env';
import { putSetting, getSetting } from './settings.service';
import * as images from './images.service';
import { runThemeAuthoring as runHostThemeAuthoring } from './theme-authoring.service';
import { createThemeAuthoringRuntime } from '../spindle/theme-authoring-runtime';
const runtime = createThemeAuthoringRuntime(
  (message) => runHostThemeAuthoring(message.userId!, message.input.operation, message.input.args),
  () => {},
);
const runThemeAuthoring = (userId: string, operation: string, args: Record<string, unknown> = {}) =>
  runtime.request({ operation, args } as any, userId);
import { ThemeAuthoringHost } from '../spindle/theme-authoring-host';
const handleThemeAuthoring = (message: any, context: any) => new ThemeAuthoringHost(context).handle(message);
import { eventBus } from '../ws/bus';
import { EventType } from '../ws/events';
import type { SpindleThemeState } from 'lumiverse-spindle-types';
import {
  encodeThemePackArchive,
  decodeThemePackArchive,
  type ThemePack,
} from '../utils/theme-pack';

const directory = mkdtempSync(join(tmpdir(), 'lumiverse-theme-'));
const browserGlobals = ['document', 'window', 'CSS'].map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
const previousFrontend = env.frontendDir,
  previousData = env.dataDir;
const theme = {
  id: 'default',
  name: 'Default',
  mode: 'dark' as const,
  accent: { h: 263, s: 55, l: 65 },
  radiusScale: 1,
  enableGlass: true,
  fontScale: 1,
};
const state = (user = 'alice') => runThemeAuthoring(user, 'state') as Promise<SpindleThemeState>;
beforeAll(() => {
  for (const [key] of browserGlobals)
    Object.defineProperty(globalThis, key, { configurable: true, value: undefined });
  env.frontendDir = directory;
  env.dataDir = directory;
  closeDatabase();
  initDatabase(':memory:');
  getDb().run(
    'CREATE TABLE settings (user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id,key))',
  );
  getDb().run(
    'CREATE TABLE theme_assets (id TEXT PRIMARY KEY, user_id TEXT, bundle_id TEXT, slug TEXT, storage_type TEXT, image_id TEXT, file_name TEXT, original_filename TEXT, mime_type TEXT, byte_size INTEGER, tags_json TEXT, metadata_json TEXT, created_at INTEGER, updated_at INTEGER, UNIQUE(user_id,bundle_id,slug))',
  );
});
afterAll(() => {
  for (const [key, descriptor] of browserGlobals)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  closeDatabase();
  env.frontendDir = previousFrontend;
  env.dataDir = previousData;
  rmSync(directory, { recursive: true, force: true });
});

test('persistent authoring and archives work without a DOM, window or browser connection', async () => {
  expect(typeof document).toBe('undefined');
  const before = await state();
  const installed: any = await runThemeAuthoring('alice', 'install', {
    draft: {
      name: 'First',
      theme,
      globalCSS: 'body { color: red }',
      components: { Test: { css: '.root { padding: 4px }' } },
    },
    options: { expectedRevision: before.revision, saveToLibrary: true },
  });
  const after = await state();
  expect(after.customCSS.css).toBe('body { color: red }');
  expect(after.backups.some((value) => value.id === installed.backupId)).toBe(true);
  expect(after.revision).not.toBe(before.revision);
  const archive = (await runThemeAuthoring('alice', 'export_current')) as Uint8Array;
  const decoded = decodeThemePackArchive(archive);
  expect(decoded.pack?.globalCSS).toBe(after.customCSS.css);
  expect(decoded.pack?.components.Test.css).toBe('.root { padding: 4px }');
  await runThemeAuthoring('alice', 'restore', {
    backupId: installed.backupId,
    expectedRevision: after.revision,
  });
  expect((await state()).theme).toBeNull();
  expect((await state()).customCSS.enabled).toBe(false);
});

test('concurrent writers with the same revision commit exactly once', async () => {
  const before = await state('concurrent');
  const results = await Promise.allSettled(
    ['One', 'Two'].map((name) =>
      runThemeAuthoring('concurrent', 'install', {
        draft: { name, globalCSS: `body { --winner: ${name} }` },
        options: { expectedRevision: before.revision },
      }),
    ),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  expect(rejected.reason.message).toContain('THEME_CONFLICT');
  expect((await state('concurrent')).backups).toHaveLength(1);
});

test('install revisions match saved state normalization and support immediate restore', async () => {
  for (const [name, configuration] of [
    ['optional-default', theme],
    ['property-order', Object.fromEntries(Object.entries({ ...theme, renderingMode: 'balanced' }).reverse())],
  ] as const) {
    const user = `revision-${name}`;
    const before = await state(user);
    const installed: any = await runThemeAuthoring(user, 'install', {
      draft: { name, theme: configuration },
      options: { expectedRevision: before.revision },
    });
    expect(installed.revision).toBe((await state(user)).revision);
    const restored: any = await runThemeAuthoring(user, 'restore', {
      backupId: installed.backupId,
      expectedRevision: installed.revision,
    });
    expect(restored.revision).toBe((await state(user)).revision);
    expect((await state(user)).theme).toBeNull();
  }
});

test('commit notifications observe complete settings and stale revisions leave state unchanged', async () => {
  const before = await state('notifications');
  const seen: string[] = [];
  const stop = eventBus.on(EventType.SETTINGS_UPDATED, (event) => {
    if (event.userId === 'notifications') seen.push(getSetting('notifications', 'customCSS')?.value.css);
  });
  try {
    await runThemeAuthoring('notifications', 'install', {
      draft: { name: 'Saved', globalCSS: 'body { color: blue }' },
      options: { expectedRevision: before.revision },
    });
    await Bun.sleep(20);
    expect(seen).toEqual(['body { color: blue }']);
    await expect(
      runThemeAuthoring('notifications', 'install', {
        draft: { name: 'Stale', globalCSS: 'body{}' },
        options: { expectedRevision: before.revision },
      }),
    ).rejects.toThrow('THEME_CONFLICT');
    expect((await state('notifications')).customCSS.css).toBe('body { color: blue }');
  } finally {
    stop();
  }
});

test('library saves materialize a null theme as defaults without changing backup snapshots', async () => {
  const user = 'library-default';
  const before = await state(user);
  const installed: any = await runThemeAuthoring(user, 'install', {
    draft: { name: 'Default styling', theme: null, globalCSS: 'body{}' },
    options: { expectedRevision: before.revision, saveToLibrary: true },
  });
  const library = getSetting(user, 'savedThemes')!.value;
  const saved = library.find((entry: any) => entry.id === installed.savedThemeId);
  const backup = library.find((entry: any) => entry.id === installed.backupId);
  expect(saved.pack.theme).toEqual(before.defaultTheme);
  expect(saved.authoringSnapshot).toBeUndefined();
  expect(backup.pack.theme).toBeNull();
  expect(backup.authoringSnapshot.themeWasNull).toBe(true);
  expect((await state(user)).theme).toBeNull();
});

test('backend permissions reject mutation before storage while allowing scoped reads', async () => {
  const messages: any[] = [];
  const context = {
    resolveUser: () => 'denied',
    canMutate: () => false,
    post: (message: any) => {
      messages.push(message);
    },
  };
  await handleThemeAuthoring(
    { type: 'theme_authoring', requestId: 'write', input: { operation: 'backup', args: {} } },
    context,
  );
  expect(messages.at(-1).error).toContain('app_manipulation');
  expect(getSetting('denied', 'savedThemes')).toBeNull();
  await handleThemeAuthoring(
    { type: 'theme_authoring', requestId: 'read', input: { operation: 'state', args: {} } },
    context,
  );
  expect(messages.at(-1).result.revision).toBeString();
  await handleThemeAuthoring(
    { type: 'theme_authoring', requestId: 'identity', input: { operation: 'state', args: {} } },
    { ...context, resolveUser: () => '' },
  );
  expect(messages.at(-1).error).toContain('userId');
});

test('assets and backups remain scoped to their user', async () => {
  const { bundleId } = (await runThemeAuthoring('alice', 'asset_create_bundle')) as any;
  const asset: any = await runThemeAuthoring('alice', 'asset_upload', {
    bundleId,
    name: 'font.ttf',
    mimeType: 'font/ttf',
    bytes: new Uint8Array([0, 1, 2, 3]),
  });
  expect(await runThemeAuthoring('bob', 'asset_list', { bundleId })).toEqual([]);
  await expect(runThemeAuthoring('bob', 'asset_download', { id: asset.id })).rejects.toThrow(
    'THEME_ASSET_NOT_FOUND',
  );
  expect(await runThemeAuthoring('bob', 'asset_delete', { id: asset.id })).toEqual({ deleted: false });
  expect(await runThemeAuthoring('alice', 'asset_download', { id: asset.id })).toEqual(
    new Uint8Array([0, 1, 2, 3]),
  );
  const backup: any = await runThemeAuthoring('alice', 'backup');
  await expect(
    runThemeAuthoring('bob', 'restore', {
      backupId: backup.backupId,
      expectedRevision: (await state('bob')).revision,
    }),
  ).rejects.toThrow('THEME_BACKUP_NOT_FOUND');
});

test('failed preparation cleans uploaded assets without partial settings or backups', async () => {
  const pack: ThemePack = {
    format: 2,
    name: 'Broken assets',
    author: '',
    description: '',
    createdAt: 0,
    bundleId: 'old',
    theme: null,
    globalCSS: '',
    components: {},
    assets: [
      {
        slug: 'assets/a.ttf',
        originalFilename: 'a.ttf',
        mimeType: 'font/ttf',
        tags: [],
        metadata: {},
        dataBase64: 'AAEC',
      },
      {
        slug: 'assets/b.exe',
        originalFilename: 'b.exe',
        mimeType: 'application/x-executable',
        tags: [],
        metadata: {},
        dataBase64: 'AAEC',
      },
    ],
  };
  await expect(
    runThemeAuthoring('failed', 'import', { bytes: encodeThemePackArchive(pack) }),
  ).rejects.toThrow();
  expect(
    (getDb().query('SELECT COUNT(*) AS count FROM theme_assets WHERE user_id = ?').get('failed') as any)
      .count,
  ).toBe(0);
  expect(getSetting('failed', 'savedThemes')).toBeNull();
});

test('CSS validation is strict at the API boundary and imports never enable TSX', async () => {
  await expect(
    runThemeAuthoring('validation', 'validate', { draft: { name: 'Broken', globalCSS: 'body {' } }),
  ).rejects.toThrow('INVALID_THEME_CSS');
  const exported = (await runThemeAuthoring('validation', 'export_draft', {
    draft: { name: 'Sanitized', globalCSS: ':root { --image: url(https://example.com/tracker) }' },
  })) as Uint8Array;
  expect(decodeThemePackArchive(exported).pack?.globalCSS).not.toContain('example.com');
  const pack: ThemePack = {
    format: 2,
    name: 'Review',
    author: '',
    description: '',
    createdAt: 0,
    bundleId: 'unused',
    theme: null,
    globalCSS: '',
    assets: [],
    components: { Test: { css: '.root{}', tsx: 'export default () => <Original />', enabled: true } },
  };
  const imported: any = await runThemeAuthoring('validation', 'import', {
    bytes: encodeThemePackArchive(pack),
  });
  expect(imported.draft.components.Test).toEqual({ css: '.root{}', enabled: false });
  expect(imported.warnings.join(' ')).toContain('TSX omitted');
});

test('persistent operations do not depend on frontend reference artifacts', async () => {
  env.frontendDir = join(directory, 'not-built');
  try {
    const before = await state('headless');
    const installed: any = await runThemeAuthoring('headless', 'install', {
      draft: { name: 'Headless', globalCSS: 'body{}', components: { Test: { css: '.root{}' } } },
      options: { expectedRevision: before.revision },
    });
    expect(installed.applied).toBe(true);
    const exported = await runThemeAuthoring('headless', 'export_current');
    expect(exported).toBeInstanceOf(Uint8Array);
    await runThemeAuthoring('headless', 'restore', {
      backupId: installed.backupId,
      expectedRevision: installed.revision,
    });
    expect((await state('headless')).customCSS.css).toBe('');
  } finally {
    env.frontendDir = directory;
  }
});

test('restoring a concurrently deleted backup cannot resurrect it', async () => {
  const backup: any = await runThemeAuthoring('restore-race', 'backup');
  const before = await state('restore-race');
  const restoring = runThemeAuthoring('restore-race', 'restore', {
    backupId: backup.backupId,
    expectedRevision: before.revision,
  });
  putSetting('restore-race', 'savedThemes', []);
  await expect(restoring).rejects.toThrow('THEME_BACKUP_CONFLICT');
  expect((await state('restore-race')).revision).toBe(before.revision);
  expect(getSetting('restore-race', 'savedThemes')?.value).toEqual([]);
});

test('database failure rolls back all theme keys and staged assets', async () => {
  const bundle: any = await runThemeAuthoring('rollback', 'asset_create_bundle');
  await runThemeAuthoring('rollback', 'asset_upload', {
    bundleId: bundle.bundleId,
    name: 'a.ttf',
    mimeType: 'font/ttf',
    bytes: new Uint8Array([1, 2, 3]),
  });
  const before = await state('rollback');
  getDb().run(
    "CREATE TRIGGER reject_theme_commit BEFORE INSERT ON settings WHEN NEW.user_id = 'rollback' AND NEW.key = 'componentOverrides' BEGIN SELECT RAISE(ABORT, 'blocked'); END",
  );
  try {
    await expect(
      runThemeAuthoring('rollback', 'install', {
        draft: { name: 'Fail', theme, assetBundleId: bundle.bundleId },
        options: { expectedRevision: before.revision },
      }),
    ).rejects.toThrow('blocked');
    expect((await state('rollback')).revision).toBe(before.revision);
    expect((await state('rollback')).backups).toEqual([]);
    expect(
      (getDb().query('SELECT COUNT(*) AS count FROM theme_assets WHERE user_id = ?').get('rollback') as any)
        .count,
    ).toBe(1);
  } finally {
    getDb().run('DROP TRIGGER reject_theme_commit');
  }
});

test('notification failure cannot undo a committed install', async () => {
  const before = await state('notify-failure');
  const broadcast = spyOn(eventBus, 'emit').mockImplementation(() => {
    throw new Error('transport unavailable');
  });
  const warning = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const installed: any = await runThemeAuthoring('notify-failure', 'install', {
      draft: { name: 'Committed', globalCSS: 'body{color:red}' },
      options: { expectedRevision: before.revision },
    });
    expect(installed.applied).toBe(true);
    expect((await state('notify-failure')).revision).toBe(installed.revision);
    expect((await state('notify-failure')).backups).toHaveLength(1);
    expect(warning).toHaveBeenCalledTimes(1);
  } finally {
    broadcast.mockRestore();
    warning.mockRestore();
  }
});

test('revocation or runtime disposal during preparation prevents commit', async () => {
  for (const mode of ['revoked', 'stopped']) {
    let allowed = true;
    const replies: any[] = [];
    const host = new ThemeAuthoringHost({
      resolveUser: () => mode,
      canMutate: () => allowed,
      post: (message) => {
        replies.push(message);
      },
    });
    const before = await state(mode);
    const pending = host.handle({
      type: 'theme_authoring',
      requestId: mode,
      input: {
        operation: 'install',
        args: {
          draft: { name: 'Interrupted', globalCSS: 'body{}' },
          options: { expectedRevision: before.revision },
        },
      },
    });
    if (mode === 'stopped') host.dispose();
    else allowed = false;
    await pending;
    expect(replies.at(-1).error).toContain(mode === 'stopped' ? 'stopped' : 'app_manipulation');
    expect((await state(mode)).revision).toBe(before.revision);
    expect((await state(mode)).backups).toEqual([]);
  }
});

test('worker-side mutation guards run before archive processing or dispatch', async () => {
  let calls = 0;
  const guarded = createThemeAuthoringRuntime(
    async () => {
      calls++;
    },
    () => {
      throw new Error('non-committing invocation');
    },
  );
  await expect(
    guarded.request({ operation: 'import', args: { bytes: new Uint8Array([0]) } }),
  ).rejects.toThrow('non-committing');
  await expect(
    guarded.request({ operation: 'install', args: { draft: { name: 'Denied' } } }),
  ).rejects.toThrow('non-committing');
  expect(calls).toBe(0);
});

test('revocation or runtime disposal during asset upload prevents persistence', async () => {
  for (const mode of ['revoked', 'stopped']) {
    const user = `upload-${mode}`;
    let allowed = true;
    const replies: any[] = [];
    const host = new ThemeAuthoringHost({
      resolveUser: () => user,
      canMutate: () => allowed,
      post: (message) => { replies.push(message); },
    });
    const pending = host.handle({
      type: 'theme_authoring',
      requestId: user,
      input: {
        operation: 'asset_upload',
        args: { bundleId: 'bundle', name: 'font.ttf', mimeType: 'font/ttf', bytes: new Uint8Array([1, 2, 3]) },
      },
    });
    if (mode === 'stopped') host.dispose();
    else allowed = false;
    await pending;
    expect(replies.at(-1).error).toContain(mode === 'stopped' ? 'stopped' : 'app_manipulation');
    expect(await runThemeAuthoring(user, 'asset_list', { bundleId: 'bundle' })).toEqual([]);
    expect(Array.from(new Bun.Glob('**/*').scanSync({ cwd: join(directory, 'theme-assets', user), onlyFiles: true }))).toEqual([]);
  }
});

test('revocation or runtime disposal during optimization preserves the original image', async () => {
  const originalPath = join(directory, 'original.png');
  await Bun.write(originalPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM9sAAAAASUVORK5CYII=', 'base64'));
  const path = spyOn(images, 'getImageFilePath').mockResolvedValue(originalPath);
  const upload = spyOn(images, 'uploadImage').mockResolvedValue({ id: 'staged-image' } as any);
  const remove = spyOn(images, 'deleteImageAsync').mockResolvedValue(true);
  try {
    for (const mode of ['revoked', 'stopped']) {
      remove.mockClear();
      const user = `optimize-${mode}`;
      getDb().query('INSERT INTO theme_assets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(user, user, 'bundle', 'assets/image.png', 'image', 'original-image', null, 'image.png', 'image/png', 1, '[]', '{}', 0, 0);
      let allowed = true;
      const replies: any[] = [];
      const host = new ThemeAuthoringHost({
        resolveUser: () => user,
        canMutate: () => allowed,
        post: (message) => { replies.push(message); },
      });
      const pending = host.handle({
        type: 'theme_authoring',
        requestId: user,
        input: { operation: 'asset_optimize', args: { id: user } },
      });
      if (mode === 'stopped') host.dispose();
      else allowed = false;
      await pending;
      expect(replies.at(-1).error).toContain(mode === 'stopped' ? 'stopped' : 'app_manipulation');
      expect((getDb().query('SELECT image_id FROM theme_assets WHERE id = ?').get(user) as any).image_id).toBe('original-image');
      expect(remove.mock.calls).toEqual([[user, 'staged-image']]);
    }
  } finally {
    path.mockRestore();
    upload.mockRestore();
    remove.mockRestore();
  }
});

test('a real backend worker authors and round-trips an asset-bearing theme with no frontend', async () => {
  const worker = new Worker(new URL('../spindle/theme-authoring-worker.fixture.ts', import.meta.url), {
    type: 'module',
  });
  let exportResultWasBytes: boolean | undefined;
  const host = new ThemeAuthoringHost({
    resolveUser: (user) => {
      if (user !== 'worker') throw new Error('Wrong scope');
      return user;
    },
    canMutate: () => true,
    post: (response) => {
      if (response.result && typeof response.result === 'object' && 'format' in response.result)
        exportResultWasBytes = response.result instanceof Uint8Array;
      worker.postMessage(response);
    },
  });
  try {
    const result: any = await new Promise((resolve, reject) => {
      worker.onerror = (event) => reject(new Error(event.message));
      worker.onmessage = (event) => {
        if (event.data.kind === 'request') void host.handle(event.data.message);
        else if (event.data.kind === 'failed') reject(new Error(event.data.error));
        else if (event.data.kind === 'done') resolve(event.data);
      };
      worker.postMessage({ kind: 'start' });
    });
    expect(result.noBrowser).toBe(true);
    expect(result.archiveIsBytes).toBe(true);
    expect(result.archiveSize).toBeGreaterThan(0);
    expect(result.importedAssets).toBe(1);
    expect(exportResultWasBytes).toBe(false);
    expect((await state('worker')).customCSS.css).toBe('body{color:red}');
  } finally {
    host.dispose();
    worker.terminate();
  }
}, 10000);

test('the full extension runtime exposes persistent authoring over subprocess RPC', async () => {
  const entry = join(directory, 'theme-extension.mjs');
  await Bun.write(
    entry,
    `
    try {
      const api = spindle.theme.authoring;
      const state = await api.request({ operation: 'state', args: {} }, 'runtime');
      const result = await api.request({ operation: 'install', args: {
        draft: { name: 'Runtime', globalCSS: 'body{color:blue}' },
        options: { expectedRevision: state.revision }
      } }, 'runtime');
      const bytes = await api.request({ operation: 'export_current', args: {} }, 'runtime');
      spindle.sendToFrontend({ applied: result.applied, binary: bytes instanceof Uint8Array, noBrowser: typeof document === 'undefined' });
    } catch (error) { spindle.sendToFrontend({ error: error.message }); }
  `,
  );
  const completed = Promise.withResolvers<any>();
  const timer = setTimeout(() => completed.reject(new Error('Theme runtime timed out')), 10000);
  const worker = Bun.spawn([process.execPath, join(import.meta.dir, '../spindle/worker-runtime.ts')], {
    stdout: 'ignore',
    stderr: 'pipe',
    ipc(message: any, child) {
      if (message.type === 'permissions_get_granted')
        child.send({ type: 'response', requestId: message.requestId, result: ['app_manipulation'] });
      else if (message.type === 'theme_authoring') void host.handle(message);
      else if (message.type === 'frontend_message') completed.resolve(message.payload);
    },
  });
  const host = new ThemeAuthoringHost({
    resolveUser: (user) => {
      if (user !== 'runtime') throw new Error('Wrong scope');
      return user;
    },
    canMutate: () => true,
    post: (response) => worker.send(response),
  });
  try {
    worker.send({
      type: 'init',
      manifest: {
        identifier: 'theme-runtime-test',
        entry_backend: pathToFileURL(entry).href,
        permissions: ['app_manipulation'],
      },
      storagePath: directory,
    });
    expect(await completed.promise).toEqual({ applied: true, binary: true, noBrowser: true });
    expect((await state('runtime')).customCSS.css).toBe('body{color:blue}');
  } finally {
    clearTimeout(timer);
    host.dispose();
    worker.kill();
    await worker.exited;
  }
}, 15000);
