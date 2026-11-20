import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement, useEffect } from 'react'
import type { Root } from 'react-dom/client'
import { create } from 'zustand'
import type { CreatePresetInput, Preset, PresetRegistryItem } from '@/types/api'

const rows = new Map<string, Preset>()
const selections: Array<string | null> = []
const warnings: string[] = []
const created: CreatePresetInput[] = []
const writes: string[] = []
let registryGate: Promise<void> | null = null
let getError: Error | null = null
const useStoreMock = create<any>((set) => ({
  activeLoomPresetId: null,
  loomRegistry: {},
  activeProfileId: null,
  profiles: [],
  providers: [],
  setActiveLoomPreset: (id: string | null) => {
    selections.push(id)
    set({ activeLoomPresetId: id })
  },
  setLoomRegistry: (loomRegistry: unknown) => set({ loomRegistry }),
}))

mock.module('@/store', () => ({ useStore: useStoreMock }))
mock.module('@/api/presets', () => ({
  presetsApi: {
    get: async (id: string) => {
      if (getError) throw getError
      const row = rows.get(id)
      if (!row) throw new Error(`Unexpected preset: ${id}`)
      return structuredClone(row)
    },
    listRegistry: async ({ offset = 0, limit = 200 } = {}) => {
      if (registryGate) await registryGate
      const data: PresetRegistryItem[] = [...rows.values()].map((row) => ({
        id: row.id, name: row.name, provider: 'loom', block_count: 2, updated_at: 1,
      }))
      return { data: data.slice(offset, offset + limit), total: data.length }
    },
    listRegistryAll: async () => {
      if (registryGate) await registryGate
      const data = [...rows.values()].map(row => ({ id: row.id, name: row.name, provider: 'loom', block_count: 2, updated_at: 1 }))
      return { data, total: data.length }
    },
    create: async (input: CreatePresetInput) => {
      created.push(structuredClone(input))
      const row = { ...input, id: 'recovered', created_at: 1, updated_at: 1 } as Preset
      rows.set(row.id, row)
      return structuredClone(row)
    },
    update: async (id: string) => {
      writes.push(id)
      return rows.get(id)
    },
  },
}))
mock.module('@/api/macros', () => ({ getMacroCatalog: async () => ({ categories: [] }) }))
mock.module('@/lib/toast', () => ({
  toast: { warning: (message: string) => warnings.push(message), error: (message: string) => warnings.push(message) },
}))
mock.module('@/i18n', () => ({ default: { t: (key: string) => key, language: 'en' } }))

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const globals = globalThis as unknown as Record<string, unknown>
const replacements = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
}
const originals = new Map(Object.keys(replacements).map((key) => [key, globals[key]]))
Object.assign(globals, replacements)

const { useLoomBuilder } = await import('./useLoomBuilder')
const { createNewLoomPreset, createPortableLoomPresetExport, marshalPreset } = await import('@/lib/loom/service')
const { InvalidLoomPresetError } = await import('@/lib/loom/preset-validation')
const { toPresetEditorDraft } = await import('@/lib/spindle/preset-editor-adapter')
const { importPresetFiles } = await import('@/lib/loom/preset-import-batch')
const { resolveLoomPresetSelection } = await import('@/lib/loom/preset-recovery')
const { configurePresetSelectionCoordinator, transitionActiveLoomPreset } = await import('@/lib/loom/preset-selection-coordinator')
const { presetSaveCoordinator, flushPresetForGeneration } = await import('@/lib/loom/preset-save-coordinator')
mock.restore()

let root: Root | null = null
let surface: ReturnType<typeof useLoomBuilder>

/* eslint-disable react-hooks/globals */
function Harness() {
  surface = useLoomBuilder()
  const preset = surface.activePreset
  // Exercise the production projection that Loom runs when publishing its editor state.
  // The previous harness only repeated validation, so it missed failures in this effect.
  useEffect(() => {
    if (preset) toPresetEditorDraft(preset)
  }, [preset])
  return createElement('div', null, surface.activePreset?.description.trim())
}
/* eslint-enable react-hooks/globals */

function addPreset(id: string, malformed = false, name = id): Preset {
  const row = { ...marshalPreset(createNewLoomPreset(name)), id, created_at: 1, updated_at: 1 } as Preset
  if (malformed) row.metadata.description = { extension: 'invalid' }
  rows.set(id, row)
  return row
}

async function mount(id: string | null) {
  useStoreMock.setState({
    activeLoomPresetId: id,
    loomRegistry: Object.fromEntries([...rows.values()].map((row) => [row.id, { name: row.name }])),
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(host)
  await act(async () => { root!.render(createElement(Harness)) })
}

beforeEach(() => {
  rows.clear()
  selections.length = 0
  warnings.length = 0
  writes.length = 0
  created.length = 0
  registryGate = null
  getError = null
  presetSaveCoordinator.setScope(crypto.randomUUID())
  configurePresetSelectionCoordinator({
    getActivePresetId: () => useStoreMock.getState().activeLoomPresetId,
    setActivePresetId: (id) => useStoreMock.getState().setActiveLoomPreset(id),
    flushPreset: flushPresetForGeneration,
    resolvePresetId: resolveLoomPresetSelection,
  })
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = null
  document.body.replaceChildren()
})

afterAll(() => {
  dom.window.close()
  for (const [key, value] of originals) {
    if (value === undefined) delete globals[key]
    else globals[key] = value
  }
})

describe('Loom malformed preset recovery', () => {
  test('rejects a malformed extension draft before publishing or saving it', async () => {
    addPreset('working')
    await mount('working')
    const before = presetSaveCoordinator.getDraft('working')
    await act(async () => {
      expect(() => surface.updatePresetDraft((draft) => ({
        ...draft,
        blocks: draft.blocks.map((block) => ({ ...block, extensionPayload: {} })),
      }))).toThrow(InvalidLoomPresetError)
    })
    expect(presetSaveCoordinator.getDraft('working')).toEqual(before)
    expect(presetSaveCoordinator.hasPendingChanges('working')).toBe(false)
    expect(surface.activePreset?.id).toBe('working')
    expect(writes).toEqual([])
  })

  test('rejects an uploaded malformed preset before it is saved or published to the editor', async () => {
    addPreset('working')
    await mount('working')
    const uploaded = createNewLoomPreset('Malformed upload')
    Object.assign(uploaded.blocks[0], { extensionPayload: {} })
    let result!: Awaited<ReturnType<typeof importPresetFiles>>
    await act(async () => {
      result = await importPresetFiles([new File([JSON.stringify(uploaded)], 'malformed.json')], surface.importFromFile, {
        invalidJson: 'Invalid JSON', importFailed: 'Import failed',
      })
    })
    expect(result.imported).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(created).toEqual([])
    expect(selections).toEqual([])
    expect(surface.activePreset?.id).toBe('working')
    expect(surface.isLoading).toBe(false)
    expect(warnings).toContain('loomBuilder.toast.invalidPresetImport')
  })

  test('recovers an already saved preset that would throw while publishing editor state', async () => {
    const row = addPreset('damaged')
    Object.assign(row.prompt_order[0] as object, { extensionPayload: {} })
    addPreset('working')
    await mount('damaged')
    expect(surface.activePreset?.id).toBe('working')
    expect(surface.isLoading).toBe(false)
    expect(warnings).toContain('loomBuilder.toast.presetRecovered')
  })

  test('still imports portable presets with no stored id', async () => {
    addPreset('working')
    await mount('working')
    const exported = createPortableLoomPresetExport(createNewLoomPreset('Portable upload'))
    expect(Object.hasOwn(exported, 'id')).toBe(false)
    await act(async () => { await surface.importFromFile(JSON.parse(JSON.stringify(exported)), 'portable.json') })
    expect(surface.activePreset?.name).toBe('Portable upload')
    expect(created).toHaveLength(1)
    expect(surface.isLoading).toBe(false)
  })

  test('continues a file upload batch after syntax and schema errors', async () => {
    addPreset('working')
    await mount('working')
    const malformed = createPortableLoomPresetExport(createNewLoomPreset('Bad schema'))
    Object.assign(malformed.blocks[0], { extensionPayload: {} })
    const valid = createPortableLoomPresetExport(createNewLoomPreset('Valid upload'))
    let result!: Awaited<ReturnType<typeof importPresetFiles>>
    await act(async () => {
      result = await importPresetFiles([
        new File(['{"blocks": ['], 'invalid-syntax.json'),
        new File([JSON.stringify(malformed)], 'malformed.json'),
        new File([JSON.stringify(valid)], 'valid.json'),
      ], surface.importFromFile, { invalidJson: 'Invalid JSON', importFailed: 'Import failed' })
    })
    expect(result.imported).toBe(1)
    expect(result.errors).toHaveLength(2)
    expect(created).toHaveLength(1)
    expect(surface.activePreset?.name).toBe('Valid upload')
    expect(surface.error).toBeNull()
  })

  test('falls back when the first selection is malformed and there is no previous preset', async () => {
    addPreset('damaged', true)
    addPreset('working')
    await mount(null)
    await act(async () => { await surface.selectPreset('damaged') })
    expect(surface.activePreset?.id).toBe('working')
    expect(selections).toEqual(['working'])
    expect(surface.isLoading).toBe(false)
  })

  test('opens with a validated default and persists its selection while preserving the malformed row', async () => {
    const damaged = structuredClone(addPreset('damaged', true))
    addPreset('also-damaged', true)
    addPreset('default', false, 'Default')
    await mount('damaged')

    expect(surface.activePreset?.id).toBe('default')
    expect(surface.isLoading).toBe(false)
    expect(surface.error).toBeNull()
    expect(selections).toEqual(['default'])
    expect(rows.get('damaged')).toEqual(damaged)
    expect(writes).toEqual([])
    expect(created).toEqual([])
    expect(warnings).toContain('loomBuilder.toast.presetRecovered')

    // A bound chat/profile can try the damaged preset again without causing a recovery loop.
    await act(async () => { expect(await transitionActiveLoomPreset('damaged')).toBe(false) })
    expect(selections).toEqual(['default'])
    expect(surface.activePreset?.id).toBe('default')
  })

  test('keeps the last working preset on malformed manual selection, then allows a valid selection', async () => {
    addPreset('working')
    addPreset('damaged', true)
    addPreset('next')
    await mount('working')
    await act(async () => { await surface.selectPreset('damaged') })
    expect(surface.activePreset?.id).toBe('working')
    expect(useStoreMock.getState().activeLoomPresetId).toBe('working')
    expect(surface.isLoading).toBe(false)
    await act(async () => { await surface.selectPreset('next') })
    expect(surface.activePreset?.id).toBe('next')
    expect(surface.error).toBeNull()
  })

  test('skips malformed defaults and other candidates, creating one safe preset when all are malformed', async () => {
    addPreset('damaged', true)
    addPreset('default', true, 'Default')
    await mount('damaged')
    expect(surface.activePreset?.id).toBe('recovered')
    expect(surface.activePreset?.blocks.some((block) => block.marker === 'chat_history')).toBe(true)
    expect(surface.isLoading).toBe(false)
    expect(created).toHaveLength(1)
    expect(writes).toEqual([])
    expect(rows.has('damaged')).toBe(true)
    expect(rows.has('default')).toBe(true)
  })

  test('finds a working preset beyond the first registry page', async () => {
    addPreset('damaged', true)
    for (let index = 0; index < 200; index += 1) addPreset(`damaged-${index}`, true)
    addPreset('working')
    await mount('damaged')
    expect(surface.activePreset?.id).toBe('working')
    expect(created).toEqual([])
  })

  test('does not replace a newer selection when an older recovery finishes', async () => {
    addPreset('damaged', true)
    addPreset('working')
    let release!: () => void
    registryGate = new Promise<void>((resolve) => { release = resolve })
    try {
      await mount('damaged')
      expect(surface.isLoading).toBe(true)
      await act(async () => { await surface.selectPreset('working') })
      await act(async () => { release() })
      expect(selections).toEqual(['working'])
      expect(surface.activePreset?.id).toBe('working')
      expect(surface.isLoading).toBe(false)
      expect(created).toEqual([])
    } finally {
      await act(async () => { release() })
    }
  })

  test('does not replace a preset for a temporary transport failure and clears the error on success', async () => {
    addPreset('working')
    addPreset('next')
    getError = new Error('Offline')
    await mount('working')
    expect(surface.error).toBe('Offline')
    expect(surface.isLoading).toBe(false)
    expect(created).toEqual([])
    expect(selections).toEqual([])
    getError = null
    await act(async () => { await surface.selectPreset('next') })
    expect(surface.activePreset?.id).toBe('next')
    expect(surface.error).toBeNull()
  })
})
