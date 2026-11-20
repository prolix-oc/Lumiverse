import { describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import type { Preset } from '@/types/api'
import { createPresetSaveCoordinator } from './preset-save-coordinator'
import { importFromSTPreset, marshalPreset, unmarshalPreset } from './service'

const MIB = 1024 * 1024
const PENDING_KEY = '__lumiverse_pending_loom_presets'
const SCOPED_PENDING_KEY = `${PENDING_KEY}:recovery-test`
const offlineAdapter = { async update(): Promise<Preset> { throw new Error('Offline') } }

async function withQuotaStorage(run: () => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!
  const dom = new JSDOM('', { url: 'https://recovery.test', storageQuota: 5 * MIB })
  Object.defineProperty(globalThis, 'localStorage', {
    value: dom.window.localStorage, configurable: true, writable: true,
  })
  try {
    await run()
  } finally {
    Object.defineProperty(globalThis, 'localStorage', original)
    dom.window.close()
  }
}

function importedRow(extensionSize: number): Preset {
  const preset = importFromSTPreset({
    prompts: [{ identifier: 'tone', name: 'Tone', content: 'Write vividly.' }],
    extensions: {
      tavern_helper: { scripts: [{ id: 'panel', content: 'x'.repeat(extensionSize) }] },
    },
  }, 'Imported preset')
  const input = marshalPreset(preset)
  return {
    ...input,
    id: preset.id,
    parameters: input.parameters ?? {},
    prompt_order: input.prompt_order ?? [],
    prompts: input.prompts ?? {},
    metadata: input.metadata ?? {},
    cache_revision: 1,
    created_at: 1,
    updated_at: 1,
  }
}

describe('preset recovery with large imported extensions', () => {
  test.each([
    { extensionSize: 6 * MIB, existingSize: 0 },
    { extensionSize: 3 * MIB, existingSize: 3 * MIB },
  ])('recovers an offline rename with $extensionSize extension characters and $existingSize existing characters', async ({ extensionSize, existingSize }) => {
    await withQuotaStorage(async () => {
      if (existingSize) localStorage.setItem('other-origin-data', 'x'.repeat(existingSize))
      const row = importedRow(extensionSize)
      const base = unmarshalPreset(row)
      const coordinator = createPresetSaveCoordinator(offlineAdapter)
      coordinator.setScope('recovery-test')
      coordinator.hydrate(base)
      coordinator.mutate(base.id, base, (draft) => ({ ...draft, name: 'Unsaved rename' }), { immediate: true })
      await expect(coordinator.flush(base.id)).rejects.toThrow('Offline')

      const pending = localStorage.getItem(SCOPED_PENDING_KEY)
      expect(pending).not.toBeNull()
      expect(pending!.length).toBeLessThan(1024)

      // A new coordinator models a reload. Untouched namespaces and the
      // concurrency revision must come from the fresh server read.
      const fresh = {
        ...row,
        cache_revision: 2,
        metadata: { ...row.metadata, sibling_extension: { revision: 2 } },
      }
      const reloaded = createPresetSaveCoordinator({
        async update(presetId, input) {
          expect(presetId).toBe(base.id)
          expect(input.expected_cache_revision).toBe(2)
          expect(input.metadata?.tavern_helper).toEqual(row.metadata.tavern_helper)
          expect(input.metadata?.sibling_extension).toEqual({ revision: 2 })
          expect(input.prompt_order).toEqual(row.prompt_order)
          return { ...fresh, ...input, cache_revision: 3 }
        },
      })
      reloaded.setScope('recovery-test')
      expect(reloaded.hasDurablePendingRecovery(base.id)).toBe(true)
      const recovered = reloaded.hydrate(unmarshalPreset(fresh))
      expect(recovered.name).toBe('Unsaved rename')
      expect(recovered.passthroughMetadata.tavern_helper).toEqual(row.metadata.tavern_helper)
      expect(recovered.passthroughMetadata.sibling_extension).toEqual({ revision: 2 })
      expect(recovered.blocks).toEqual(base.blocks)
      await reloaded.flush(base.id)
      expect(localStorage.getItem(SCOPED_PENDING_KEY)).toBeNull()
    })
  })

  test('recovers changed and deleted extension keys without replaying untouched namespaces', async () => {
    await withQuotaStorage(async () => {
      const row = importedRow(6 * MIB)
      row.metadata = {
        ...row.metadata,
        ...JSON.parse('{"__proto__":{"mode":"old"},"removed":{"enabled":true}}'),
        sibling_extension: { revision: 1 },
      }
      const base = unmarshalPreset(row)
      const coordinator = createPresetSaveCoordinator(offlineAdapter)
      coordinator.setScope('recovery-test')
      coordinator.hydrate(base)
      coordinator.mutate(base.id, base, (draft) => {
        const metadata: Record<string, unknown> = { ...draft.passthroughMetadata, ['__proto__']: { mode: 'new' } }
        delete metadata.removed
        return { ...draft, passthroughMetadata: metadata }
      }, { immediate: true })
      await expect(coordinator.flush(base.id)).rejects.toThrow('Offline')

      const pending = localStorage.getItem(SCOPED_PENDING_KEY)
      expect(pending).not.toBeNull()
      expect(pending!.length).toBeLessThan(1024)
      const reloaded = createPresetSaveCoordinator(offlineAdapter)
      reloaded.setScope('recovery-test')
      const fresh = unmarshalPreset({
        ...row,
        metadata: { ...row.metadata, sibling_extension: { revision: 2 } },
      })
      const recovered = reloaded.hydrate(fresh)
      expect(Object.getPrototypeOf(recovered.passthroughMetadata)).toBe(Object.prototype)
      expect(Object.hasOwn(recovered.passthroughMetadata, '__proto__')).toBe(true)
      expect(recovered.passthroughMetadata.__proto__).toEqual({ mode: 'new' })
      expect(Object.hasOwn(recovered.passthroughMetadata, 'removed')).toBe(false)
      expect(recovered.passthroughMetadata.sibling_extension).toEqual({ revision: 2 })
      expect(recovered.passthroughMetadata.tavern_helper).toEqual(row.metadata.tavern_helper)
    })
  })

  test('ignores a sparse recovery record whose dirty blocks are missing', async () => {
    await withQuotaStorage(async () => {
      const row = importedRow(0)
      localStorage.setItem(SCOPED_PENDING_KEY, JSON.stringify({
        [row.id]: {
          __lumiverse_pending_loom_preset_v3: 3,
          preset: { id: row.id, passthroughMetadata: {} },
          dirty: { fields: ['blocks'], passthroughKeys: [] },
          revision: 1,
        },
      }))
      const coordinator = createPresetSaveCoordinator(offlineAdapter)
      coordinator.setScope('recovery-test')
      expect(coordinator.hasDurablePendingRecovery(row.id)).toBe(false)
      expect(coordinator.hydrate(unmarshalPreset(row)).blocks).toEqual(row.prompt_order)
      expect(coordinator.hasPendingChanges(row.id)).toBe(false)
    })
  })

  test.each(['raw', 'v1', 'v2'])('migrates a large unscoped %s recovery record without duplicating untouched blobs', async (format) => {
    await withQuotaStorage(async () => {
      localStorage.setItem('other-origin-data', 'x'.repeat(MIB))
      const row = importedRow(3 * MIB)
      const draft = { ...unmarshalPreset(row), name: 'Legacy unsaved name' }
      const legacy = format === 'raw' ? draft : {
        [`__lumiverse_pending_loom_preset_${format}`]: format === 'v1' ? 1 : 2,
        preset: draft,
        dirty: { fields: ['name'], passthroughKeys: [] },
        revision: 1,
      }
      localStorage.setItem(PENDING_KEY, JSON.stringify({ [row.id]: legacy }))

      const coordinator = createPresetSaveCoordinator(offlineAdapter)
      coordinator.setScope('recovery-test')
      const recovered = coordinator.hydrate(unmarshalPreset(row))
      expect(recovered.name).toBe('Legacy unsaved name')
      expect(recovered.passthroughMetadata.tavern_helper).toEqual(row.metadata.tavern_helper)
      expect(localStorage.getItem(PENDING_KEY)).toBeNull()
      const pending = localStorage.getItem(SCOPED_PENDING_KEY)
      expect(pending).not.toBeNull()
      expect(pending!.length).toBeLessThan(8192)

      const reloaded = createPresetSaveCoordinator(offlineAdapter)
      reloaded.setScope('recovery-test')
      expect(reloaded.hydrate(unmarshalPreset(row)).name).toBe('Legacy unsaved name')
    })
  })
})
