import { DEFAULT_THEME, normalizeTheme } from '../utils/theme-config';
import { THEME_AUTHORING_ACCESS, validateThemeRequest } from './theme-authoring-requests';
import { createHash } from 'node:crypto';
import { getDb } from '../db/connection';
import { getSettingsByKeys } from './settings.service';
import { serializeValueOrThrow } from './settings-validation';
import * as assets from './theme-assets.service';
import { eventBus } from '../ws/bus';
import { EventType } from '../ws/events';
import { prepareThemeDraft } from './theme-authoring-validation';
import {
  createThemePack,
  normalizeThemePack,
  restoreThemePackComponents,
  type ThemePack,
  type ThemePackAsset,
} from '../utils/theme-pack';
import type {
  SpindleThemeDraft,
  SpindleThemeState,
  SpindleThemeInstallOptions,
  ThemeAuthoringAssetPatch,
} from 'lumiverse-spindle-types';
import type { ThemeAsset } from '../types/theme-asset';

export const THEME_READ_OPERATIONS = new Set(
  Object.entries(THEME_AUTHORING_ACCESS)
    .filter(([, access]) => access === 'read')
    .map(([name]) => name),
);
export const THEME_WRITE_OPERATIONS = new Set(
  Object.entries(THEME_AUTHORING_ACCESS)
    .filter(([, access]) => access === 'write')
    .map(([name]) => name),
);
const THEME_SETTING_KEYS = ['theme', 'customCSS', 'componentOverrides'];
type State = Pick<SpindleThemeState, 'theme' | 'customCSS' | 'components'>;
interface SavedPack {
  kind: 'pack';
  id: string;
  name: string;
  createdAt: number;
  pack: ThemePack;
  authoringSnapshot?: { version: 1; globalEnabled: boolean; themeWasNull: boolean };
}

function readState(userId: string): State {
  const settings = getSettingsByKeys(userId, THEME_SETTING_KEYS);
  return {
    theme: normalizeTheme(settings.get('theme')),
    customCSS: settings.get('customCSS') ?? { css: '', enabled: false, revision: 0, bundleId: null },
    components: settings.get('componentOverrides') ?? {},
  };
}
function getRevision(state: State): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        theme: normalizeTheme(state.theme),
        customCSS: state.customCSS,
        components: state.components,
      }),
    )
    .digest('hex');
}
function savedThemes(userId: string): SavedPack[] {
  return getSettingsByKeys(userId, ['savedThemes']).get('savedThemes') ?? [];
}
function assertRevision(expected: unknown, current: State): void {
  if (typeof expected !== 'string' || expected !== getRevision(current))
    throw new Error('THEME_CONFLICT: read the current theme before applying changes.');
}
function createSavedPack(pack: ThemePack, state?: State): SavedPack {
  const saved: SavedPack = {
    kind: 'pack',
    id: crypto.randomUUID(),
    name: pack.name,
    createdAt: Math.floor(Date.now() / 1000),
    pack,
  };
  if (state) {
    saved.authoringSnapshot = {
      version: 1,
      globalEnabled: state.customCSS.enabled,
      themeWasNull: state.theme === null,
    };
  }
  return saved;
}
function commitTheme(
  userId: string,
  expected: string,
  next: State | undefined,
  additions: SavedPack[],
  restoredFrom?: SavedPack,
): void {
  const changed: string[] = [];
  getDb()
    .transaction(() => {
      assertRevision(expected, readState(userId));
      const library = savedThemes(userId);
      if (
        restoredFrom &&
        JSON.stringify(library.find((saved) => saved.id === restoredFrom.id)) !==
          JSON.stringify(restoredFrom)
      )
        throw new Error('THEME_BACKUP_CONFLICT: the saved backup changed.');
      const patch: Record<string, unknown> = next
        ? { theme: next.theme, customCSS: next.customCSS, componentOverrides: next.components }
        : {};
      if (additions.length) patch.savedThemes = [...library, ...additions];
      const prepared = Object.entries(patch).map(([key, value]) => ({
        key,
        json: serializeValueOrThrow(key, value),
      }));
      const write = getDb().query(
        'INSERT INTO settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      );
      for (const item of prepared) {
        write.run(userId, item.key, item.json, Math.floor(Date.now() / 1000));
        changed.push(item.key);
      }
    })
    .immediate();
  // Notification failures must not delete assets belonging to a committed theme.
  if (changed.length)
    try {
      eventBus.emit(EventType.SETTINGS_UPDATED, { keys: changed }, userId);
    } catch (error) {
      console.warn('[theme] Settings committed, notification failed:', error);
    }
}
function publicAsset(asset: ThemeAsset) {
  return {
    id: asset.id,
    bundleId: asset.bundle_id,
    slug: asset.slug,
    originalFilename: asset.original_filename,
    mimeType: asset.mime_type,
    sizeBytes: asset.byte_size,
    tags: asset.tags,
    metadata: asset.metadata,
    cssPath: `./${asset.slug}`,
    contentUrl: `/api/v1/theme-assets/${encodeURIComponent(asset.id)}/content`,
  };
}
function requireText(value: unknown, name: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`Invalid theme ${name}.`);
  return value;
}
function requireBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > 200 * 1024 * 1024)
    throw new Error('Invalid theme archive bytes.');
  return value;
}
async function readBundleAssets(userId: string, bundleId: string | null): Promise<ThemePackAsset[]> {
  if (!bundleId) return [];
  const result: ThemePackAsset[] = [];
  const entries = assets.listThemeAssets(userId, bundleId);
  if (
    entries.length > 499 ||
    entries.reduce((sum, asset) => sum + asset.byte_size, 0) > 250 * 1024 * 1024
  )
    throw new Error('Theme assets exceed the archive limit.');
  for (const asset of entries) {
    const file = await assets.getThemeAssetContentById(userId, asset.id);
    if (!file) throw new Error('THEME_ASSET_NOT_FOUND');
    result.push({
      slug: asset.slug,
      originalFilename: asset.original_filename,
      mimeType: asset.mime_type,
      tags: asset.tags,
      metadata: asset.metadata,
      dataBase64: Buffer.from(await Bun.file(file.filepath).arrayBuffer()).toString('base64'),
    });
  }
  return result;
}
async function createSnapshot(userId: string, state: State, name: string): Promise<ThemePack> {
  return {
    ...createThemePack(
      state.theme,
      state.customCSS,
      state.components,
      await readBundleAssets(userId, state.customCSS.bundleId),
      { name },
    ),
    theme: state.theme,
    components: structuredClone(state.components),
  };
}
function validateArchiveData(value: any): ThemePack {
  if (
    !value ||
    typeof value !== 'object' ||
    value.format !== 2 ||
    !Array.isArray(value.assets) ||
    value.assets.length > 499 ||
    !value.components ||
    typeof value.components !== 'object' ||
    Array.isArray(value.components)
  )
    throw new Error('Invalid theme archive.');
  for (const component of Object.values(value.components) as any[]) {
    if (
      !component ||
      typeof component !== 'object' ||
      typeof component.css !== 'string' ||
      typeof component.tsx !== 'string' ||
      typeof component.enabled !== 'boolean'
    )
      throw new Error('Invalid theme component archive entry.');
  }
  let total = 0;
  for (const asset of value.assets) {
    const encoded = asset?.dataBase64;
    if (
      typeof encoded !== 'string' ||
      encoded.length % 4 ||
      /[^A-Za-z0-9+/=]/.test(encoded) ||
      (encoded.indexOf('=') !== -1 && encoded.indexOf('=') < encoded.length - 2)
    )
      throw new Error('Invalid theme asset encoding.');
    const size = (encoded.length / 4) * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
    total += size;
    if (size > 50 * 1024 * 1024 || total > 250 * 1024 * 1024)
      throw new Error('Theme assets exceed the archive limit.');
  }
  const pack = normalizeThemePack(value);
  if (!pack || pack.assets.length !== value.assets.length) throw new Error('Invalid theme archive.');
  return pack;
}

async function createPackAssets(userId: string, pack: ThemePack, authorize: () => void) {
  const bundleId = crypto.randomUUID(),
    uploaded: ThemeAsset[] = [];
  const cleanup = () => {
    for (const asset of uploaded) assets.deleteThemeAsset(userId, asset.id);
  };
  try {
    for (const asset of pack.assets) {
      authorize();
      uploaded.push(
        await assets.createThemeAsset(userId, {
          bundleId,
          file: new File([Buffer.from(asset.dataBase64, 'base64')], asset.originalFilename, {
            type: asset.mimeType,
          }),
          slug: asset.slug,
          tags: asset.tags,
          metadata: asset.metadata,
        }),
      );
    }
    authorize();
    return { pack: { ...pack, bundleId }, uploaded, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
async function prepareDraftPack(
  userId: string,
  draft: SpindleThemeDraft,
  state: SpindleThemeState,
  mode: 'merge' | 'replace',
) {
  const prepared = prepareThemeDraft(draft, state, mode);
  const prior =
    mode === 'merge' && draft.assetBundleId !== null
      ? await readBundleAssets(userId, state.customCSS.bundleId)
      : [];
  const incoming = draft.assetBundleId ? await readBundleAssets(userId, draft.assetBundleId) : [];
  const combined = new Map(prior.map((asset) => [asset.slug, asset]));
  for (const asset of incoming) {
    const old = combined.get(asset.slug);
    if (old && old.dataBase64 !== asset.dataBase64)
      throw new Error(`THEME_ASSET_CONFLICT:${asset.slug}`);
    combined.set(asset.slug, asset);
  }
  return {
    ...prepared,
    pack: createThemePack(
      prepared.theme,
      { css: prepared.globalCSS, enabled: prepared.globalEnabled, revision: 0, bundleId: null },
      prepared.components,
      [...combined.values()],
      draft,
    ),
  };
}

export async function runThemeAuthoring(
  userId: string,
  operation: string,
  args: Record<string, any> = {},
  authorize: () => void = () => {},
): Promise<unknown> {
  if (!THEME_READ_OPERATIONS.has(operation) && !THEME_WRITE_OPERATIONS.has(operation))
    throw new Error('Unknown theme operation.');
  validateThemeRequest(operation, args);
  const draft = args.draft as SpindleThemeDraft;
  if (operation === 'asset_create_bundle') return { bundleId: crypto.randomUUID() };
  if (operation === 'asset_list') {
    const bundleId = args.bundleId ?? readState(userId).customCSS.bundleId;
    return bundleId === null
      ? []
      : assets.listThemeAssets(userId, requireText(bundleId, 'bundle')).map(publicAsset);
  }
  if (operation === 'asset_upload') {
    const data = requireBytes(args.bytes);
    if (data.byteLength > 50 * 1024 * 1024) throw new Error('Theme asset exceeds 50 MiB.');
    return publicAsset(
      await assets.createThemeAsset(
        userId,
        {
          bundleId: requireText(args.bundleId, 'bundle'),
          file: new File([Uint8Array.from(data)], requireText(args.name, 'filename'), {
            type: requireText(args.mimeType, 'MIME type'),
          }),
          slug: args.slug as string | undefined,
          tags: args.tags as string[] | undefined,
          metadata: args.metadata as Record<string, unknown> | undefined,
        },
        authorize,
      ),
    );
  }
  if (operation === 'asset_download') {
    const file = await assets.getThemeAssetContentById(userId, requireText(args.id, 'asset id'));
    if (!file) throw new Error('THEME_ASSET_NOT_FOUND');
    return new Uint8Array(await Bun.file(file.filepath).arrayBuffer());
  }
  if (operation === 'asset_delete')
    return { deleted: assets.deleteThemeAsset(userId, requireText(args.id, 'asset id')) };
  if (operation === 'asset_update' || operation === 'asset_optimize') {
    const id = requireText(args.id, 'asset id');
    const result =
      operation === 'asset_update'
        ? assets.updateThemeAsset(userId, id, args.patch as ThemeAuthoringAssetPatch)
        : await assets.optimizeThemeAssetToWebp(userId, id, authorize);
    if (!result) throw new Error('THEME_ASSET_NOT_FOUND');
    return publicAsset(result);
  }
  const state = readState(userId);
  const expected = getRevision(state);
  const complete: SpindleThemeState = {
    ...state,
    defaultTheme: structuredClone(DEFAULT_THEME),
    revision: expected,
    backups: savedThemes(userId)
      .filter((saved) => saved.kind === 'pack' && saved.authoringSnapshot?.version === 1)
      .map(({ id, name, createdAt }) => ({ id, name, createdAt })),
  };
  if (operation === 'state') return complete;
  if (operation === 'validate')
    return { warnings: prepareThemeDraft(draft, complete, 'merge').warnings };
  if (operation === 'export_current') {
    const pack = await createSnapshot(userId, state, state.theme?.name ?? 'Current theme');
    assertRevision(expected, readState(userId));
    return pack;
  }
  if (operation === 'export_draft')
    return (await prepareDraftPack(userId, draft, complete, 'replace')).pack;
  if (operation === 'backup') {
    const backup = createSavedPack(
      await createSnapshot(
        userId,
        state,
        args.name === undefined ? 'Theme backup' : requireText(args.name, 'backup name', 200),
      ),
      state,
    );
    authorize();
    commitTheme(userId, expected, undefined, [backup]);
    return { backupId: backup.id, revision: expected };
  }
  if (operation === 'import') {
    const pack = validateArchiveData(args.pack);
    const draft: SpindleThemeDraft = {
      name: pack.name,
      author: pack.author,
      description: pack.description,
      theme: pack.theme,
      globalCSS: pack.globalCSS,
      globalEnabled: pack.globalCSSEnabled,
      components: Object.fromEntries(
        Object.entries(pack.components).map(([id, component]) => [
          id,
          { css: component.css, enabled: component.enabled && !component.tsx.trim() },
        ]),
      ),
    };
    const prepared = prepareThemeDraft(draft, complete, 'replace');
    const imported = await createPackAssets(userId, pack, authorize);
    return {
      draft: {
        ...draft,
        globalCSS: prepared.globalCSS,
        components: Object.fromEntries(
          Object.entries(prepared.components).map(([id, component]) => [
            id,
            { css: component.css, enabled: component.enabled },
          ]),
        ),
        assetBundleId: imported.pack.bundleId,
      },
      assets: imported.uploaded.map(publicAsset),
      warnings: [
        ...prepared.warnings,
        ...(Object.values(pack.components).some((component) => component.tsx.trim())
          ? ['TSX omitted. Review component replacements in the native editor.']
          : []),
      ],
    };
  }
  if (operation === 'restore') {
    assertRevision(args.expectedRevision, state);
    const saved = savedThemes(userId).find(
      (value) =>
        value.id === args.backupId && value.kind === 'pack' && value.authoringSnapshot?.version === 1,
    );
    if (!saved) throw new Error('THEME_BACKUP_NOT_FOUND');
    const backup = createSavedPack(
      await createSnapshot(userId, state, `Backup before restoring ${saved.name}`),
      state,
    );
    const restored = await createPackAssets(userId, saved.pack, authorize);
    try {
      const components = restoreThemePackComponents(restored.pack.components, state.components);
      const next: State = {
        ...state,
        theme: saved.authoringSnapshot!.themeWasNull ? null : restored.pack.theme,
        customCSS: {
          css: restored.pack.globalCSS,
          enabled: saved.authoringSnapshot!.globalEnabled,
          bundleId: restored.pack.bundleId,
          revision: Date.now(),
        },
        components,
      };
      authorize();
      commitTheme(userId, expected, next, [backup], saved);
      return { backupId: backup.id, revision: getRevision(next) };
    } catch (error) {
      restored.cleanup();
      throw error;
    }
  }
  const options = (args.options ?? {}) as SpindleThemeInstallOptions;
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new Error('Invalid theme install options.');
  const apply = options.apply !== false;
  if (!apply && options.saveToLibrary !== true) throw new Error('Choose apply or saveToLibrary.');
  if (options.mode !== undefined && !['merge', 'replace'].includes(options.mode))
    throw new Error('Invalid theme merge mode.');
  if (apply) assertRevision(options.expectedRevision, state);
  const prepared = await prepareDraftPack(userId, draft, complete, options.mode ?? 'merge');
  const backup = apply
    ? createSavedPack(await createSnapshot(userId, state, `Backup before ${draft.name}`), state)
    : undefined;
  const installed = await createPackAssets(userId, prepared.pack, authorize);
  try {
    const saved =
      options.saveToLibrary === true
        ? createSavedPack({
            ...installed.pack,
            theme: installed.pack.theme ?? structuredClone(DEFAULT_THEME),
          })
        : undefined;
    const next: State = {
      ...state,
      theme: installed.pack.theme,
      customCSS: {
        css: prepared.globalCSS,
        enabled: prepared.globalEnabled,
        bundleId: installed.pack.bundleId,
        revision: Date.now(),
      },
      components: prepared.components,
    };
    authorize();
    commitTheme(userId, expected, apply ? next : undefined, [
      ...(backup ? [backup] : []),
      ...(saved ? [saved] : []),
    ]);
    return {
      applied: apply,
      savedToLibrary: !!saved,
      savedThemeId: saved?.id,
      backupId: backup?.id,
      revision: apply ? getRevision(next) : expected,
      bundleId: installed.pack.bundleId,
      warnings: prepared.warnings,
    };
  } catch (error) {
    installed.cleanup();
    throw error;
  }
}
