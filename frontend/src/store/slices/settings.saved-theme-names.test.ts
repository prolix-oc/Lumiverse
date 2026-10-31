/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { AppStore, SavedThemePackEntry } from '@/types/store'
import { themeAssetsApi } from '@/api/theme-assets'
import { DEFAULT_THEME } from '@/theme/presets'
import { createSettingsSlice, resetSettingsPersistence } from './settings'

function createStore(): AppStore {
  const state = {} as AppStore
  const set = (partial: Partial<AppStore> | ((current: AppStore) => Partial<AppStore>)) => {
    Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
  }
  const get = () => state
  Object.assign(state, createSettingsSlice(set as never, get, {} as never))
  return state
}

function legacyPack(name = 'Slate'): SavedThemePackEntry['pack'] {
  return {
    format: 2,
    name,
    author: '',
    description: '',
    createdAt: 1,
    bundleId: 'bundle-1',
    theme: { ...DEFAULT_THEME, id: 'slate', name },
    globalCSS: '.root { color: white; }',
    components: {},
    assets: [],
  }
}

afterEach(() => {
  mock.restore()
  resetSettingsPersistence()
})

describe('saved theme names', () => {
  test('applying a backend backup restores embedded assets to a fresh bundle', async () => {
    const store = createStore()
    const pack = {
      ...legacyPack(),
      assets: [{ slug: 'assets/font.ttf', originalFilename: 'font.ttf', mimeType: 'font/ttf',
        tags: ['font'], metadata: {}, dataBase64: 'AAEC' }],
    }
    store.savedThemes = [{
      kind: 'pack', id: 'backup', name: 'Backup', createdAt: 1, pack,
      authoringSnapshot: { version: 1, globalEnabled: true, themeWasNull: false },
    }]
    const upload = spyOn(themeAssetsApi, 'upload').mockResolvedValue({ id: 'restored' } as never)

    await store.applySavedTheme('backup')

    expect(upload).toHaveBeenCalledTimes(1)
    const [file, options] = upload.mock.calls[0]
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2]))
    expect(options.slug).toBe('assets/font.ttf')
    expect(options.bundleId).not.toBe(pack.bundleId)
    expect(store.customCSS.bundleId).toBe(options.bundleId)
    expect(store.savedThemes[0]).toMatchObject({ pack: { bundleId: options.bundleId } })
  })

  test('applying a backend backup keeps unreviewed TSX disabled', () => {
    const store = createStore()
    const tsx = 'export default () => <div />'
    store.componentOverrides = {
      Disabled: { css: '', tsx, enabled: false },
      Reviewed: { css: '', tsx, enabled: true },
      Changed: { css: '', tsx: 'export default () => <span />', enabled: true },
    }
    const components = Object.fromEntries(['Disabled', 'Reviewed', 'Changed', 'Removed'].map((id) => [
      id, { css: '.root{}', tsx, enabled: true },
    ]))
    store.savedThemes = [{
      kind: 'pack', id: 'backup', name: 'Backup', createdAt: 1,
      pack: { ...legacyPack(), components },
      authoringSnapshot: { version: 1, globalEnabled: false, themeWasNull: false },
    }]

    store.applySavedTheme('backup')

    expect(store.componentOverrides.Reviewed.enabled).toBe(true)
    for (const id of ['Disabled', 'Changed', 'Removed']) {
      expect(store.componentOverrides[id].enabled).toBe(false)
      expect(store.componentOverrides[id].tsx).toBe(tsx)
    }
    expect(components.Disabled.enabled).toBe(true)
  })

  test.each(['upload failure', 'newer edit', 'backup deletion'] as const)(
    'a backup restore preserves current settings and cleans staged assets after %s', async (reason) => {
      const store = createStore()
      const asset = { slug: 'assets/font.ttf', originalFilename: 'font.ttf', mimeType: 'font/ttf',
        tags: [], metadata: {}, dataBase64: 'AAEC' }
      store.savedThemes = [{
        kind: 'pack', id: 'backup', name: 'Backup', createdAt: 1,
        pack: { ...legacyPack(), assets: [asset, { ...asset, slug: 'assets/second.ttf' }] },
        authoringSnapshot: { version: 1, globalEnabled: true, themeWasNull: false },
      }]
      const before = store.customCSS
      const pending = Promise.withResolvers<Awaited<ReturnType<typeof themeAssetsApi.upload>>>()
      spyOn(themeAssetsApi, 'upload')
        .mockResolvedValueOnce({ id: 'first' } as never)
        .mockReturnValueOnce(pending.promise)
      const remove = spyOn(themeAssetsApi, 'delete').mockResolvedValue(undefined)

      const restoring = store.applySavedTheme('backup')
      if (reason === 'upload failure') pending.reject(new Error('Upload failed'))
      else {
        if (reason === 'newer edit') store.customCSS = { ...before, css: 'body{color:blue}' }
        else store.savedThemes = []
        pending.resolve({ id: 'second' } as never)
      }
      await expect(Promise.resolve(restoring)).rejects.toThrow(
        reason === 'upload failure' ? 'Upload failed' : 'Theme changed while restoring the backup',
      )

      expect(store.customCSS.css).toBe(reason === 'newer edit' ? 'body{color:blue}' : before.css)
      expect(remove).toHaveBeenCalledWith('first')
      if (reason !== 'upload failure') expect(remove).toHaveBeenCalledWith('second')
      expect(store.savedThemes).toHaveLength(reason === 'backup deletion' ? 0 : 1)
    },
  )

  test('deleting a backup preserves assets owned by another saved theme', async () => {
    const store = createStore()
    const pack = legacyPack()
    store.customCSS = { ...store.customCSS, bundleId: 'new-bundle' }
    store.savedThemes = [
      { kind: 'pack', id: 'original', name: 'Original', createdAt: 1, pack },
      { kind: 'pack', id: 'backup', name: 'Backup', createdAt: 2, pack,
        authoringSnapshot: { version: 1, globalEnabled: true, themeWasNull: false } },
    ]
    const list = spyOn(themeAssetsApi, 'list').mockResolvedValue([])
    const remove = spyOn(themeAssetsApi, 'delete').mockResolvedValue(undefined)

    await store.deleteSavedTheme('backup')

    expect(store.savedThemes.map((entry) => entry.id)).toEqual(['original'])
    expect(list).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    store.applySavedTheme('original')
    expect(store.customCSS.bundleId).toBe(pack.bundleId)
  })

  test.each(['active', 'saved'] as const)('cleanup preserves a bundle that becomes %s while listing assets', async (reference) => {
    const store = createStore()
    const pack = legacyPack()
    store.customCSS = { ...store.customCSS, bundleId: 'new-bundle' }
    store.savedThemes = [{ kind: 'pack', id: 'backup', name: 'Backup', createdAt: 1, pack }]
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof themeAssetsApi.list>>>()
    const list = spyOn(themeAssetsApi, 'list').mockReturnValue(pending.promise)
    const remove = spyOn(themeAssetsApi, 'delete').mockResolvedValue(undefined)

    const deleting = store.deleteSavedTheme('backup')
    expect(list).toHaveBeenCalledWith(pack.bundleId)
    if (reference === 'active') store.customCSS = { ...store.customCSS, bundleId: pack.bundleId }
    else store.savedThemes = [{ kind: 'pack', id: 'retained', name: 'Retained', createdAt: 2, pack }]
    pending.resolve([{ id: 'asset' }] as Awaited<ReturnType<typeof themeAssetsApi.list>>)
    await deleting

    expect(remove).not.toHaveBeenCalled()
  })

  test('deleting the last owner of an inactive bundle still cleans up its assets', async () => {
    const store = createStore()
    store.customCSS = { ...store.customCSS, bundleId: 'new-bundle' }
    store.savedThemes = [{ kind: 'pack', id: 'backup', name: 'Backup', createdAt: 1, pack: legacyPack() }]
    spyOn(themeAssetsApi, 'list').mockResolvedValue([{ id: 'asset' }] as Awaited<ReturnType<typeof themeAssetsApi.list>>)
    const remove = spyOn(themeAssetsApi, 'delete').mockResolvedValue(undefined)

    await store.deleteSavedTheme('backup')

    expect(store.savedThemes).toEqual([])
    expect(remove).toHaveBeenCalledWith('asset')
  })

  test('applying a backend backup restores disabled CSS and the default theme', () => {
    const store = createStore()
    store.theme = { ...DEFAULT_THEME, name: 'Changed' }
    store.savedThemes = [{
      kind: 'pack', id: 'backup', name: 'Backup', createdAt: 1,
      pack: { ...legacyPack(), theme: null },
      authoringSnapshot: { version: 1, globalEnabled: false, themeWasNull: true },
    }]
    store.applySavedTheme('backup')
    expect(store.theme).toBeNull()
    expect(store.customCSS.css).toBe('.root { color: white; }')
    expect(store.customCSS.enabled).toBe(false)
  })

  test('renaming an active bundle synchronizes the saved pack and live theme name', () => {
    const store = createStore()
    store.theme = { ...DEFAULT_THEME, id: 'slate', name: 'Slate' }
    store.customCSS = { ...store.customCSS, bundleId: 'bundle-1' }
    store.savedThemes = [{
      kind: 'pack',
      id: 'saved-pack',
      name: 'Slate',
      createdAt: 1,
      pack: legacyPack(),
    }]

    store.renameSavedTheme('saved-pack', 'Starry Elegance')

    const saved = store.savedThemes[0]
    expect(saved.name).toBe('Starry Elegance')
    expect(saved.kind).toBe('pack')
    if (saved.kind !== 'pack') throw new Error('Expected pack entry')
    expect(saved.pack.name).toBe('Starry Elegance')
    expect(saved.pack.theme?.name).toBe('Starry Elegance')
    expect(store.theme?.name).toBe('Starry Elegance')
  })

  test('applying legacy saved entries promotes the visible library name to the live theme', () => {
    const store = createStore()
    store.theme = { ...DEFAULT_THEME, name: 'Lumiverse Purple' }
    store.savedThemes = [
      {
        kind: 'config',
        id: 'saved-config',
        name: 'Void Bloom',
        createdAt: 1,
        theme: { ...DEFAULT_THEME, id: 'slate', name: 'Slate' },
      },
      {
        kind: 'pack',
        id: 'saved-pack',
        name: 'Honeyed Twilight',
        createdAt: 1,
        pack: legacyPack(),
      },
    ]

    store.applySavedTheme('saved-config')
    expect(store.theme?.name).toBe('Void Bloom')

    store.applySavedTheme('saved-pack')
    expect(store.theme?.name).toBe('Honeyed Twilight')
    expect(store.customCSS.bundleId).toBe('bundle-1')
  })
})
