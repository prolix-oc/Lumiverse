import { afterEach, describe, expect, test } from 'bun:test'
import {
  createPresetEditorScopedHelper,
  flushPresetEditorDraft,
  getPresetEditorState,
  setPresetEditorController,
  subscribePresetEditorState,
  syncPresetEditorState,
  updatePresetEditorDraft,
} from './preset-editor-helper'
import { createPresetEditorAccess } from './preset-editor-access'
import type { PromptBlockDTO } from 'lumiverse-spindle-types'
import type { PromptVariableValuesDTO } from 'lumiverse-spindle-types'
import type {
  SpindlePresetEditorDraft,
  SpindlePresetEditorExtensionState,
  SpindlePresetEditorState,
} from './preset-editor-types'

function sealedBlock(): PromptBlockDTO & Record<string, unknown> {
  return {
    id: 'sealed-block',
    name: 'Sealed',
    content: 'private',
    role: 'system',
    enabled: true,
    position: 'pre_history',
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    characterTagTrigger: [],
    group: null,
    categoryMode: null,
    variables: [{
      id: 'tone-id',
      name: 'tone',
      label: 'Tone',
      type: 'text',
      defaultValue: '',
    }],
    sealed: true,
    sealedKey: 'private',
    sealedSource: 'lumihub',
    sealedOriginPresetId: 'preset-1',
    sealedOriginVersion: '1',
    sealedSha256: 'hash',
  }
}


function draft(): SpindlePresetEditorDraft {
  return {
    id: 'preset-1',
    name: 'Preset',
    blocks: [sealedBlock()],
    parameters: {},
    prompts: {},
    metadata: {
      another_extension: { preserved: true },
    },
    createdAt: 1,
    updatedAt: 2,
  }
}
function publishedDraft(id = 'preset-1'): SpindlePresetEditorDraft {
  const current = draft()
  const published = {
    ...current,
    id,
    metadata: { another_extension: { preserved: true } },
  } as SpindlePresetEditorDraft & { promptVariables?: unknown }
  delete published.promptVariables
  return published
}
function legacyDraft(id = 'preset-1'): SpindlePresetEditorDraft {
  const current = draft()
  return {
    ...current,
    id,
    promptVariables: { 'sealed-block': { tone: 'legacy' } },
    metadata: {
      promptVariables: { 'sealed-block': { tone: 'legacy-metadata' } },
      another_extension: { preserved: true },
    },
  } as SpindlePresetEditorDraft & { promptVariables: unknown }
}
const activeSubscriptions = new Set<() => void>()

function trackPresetSubscription(unsubscribe: () => void): () => void {
  activeSubscriptions.add(unsubscribe)
  return () => {
    activeSubscriptions.delete(unsubscribe)
    unsubscribe()
  }
}

function subscribeForTest(listener: (state: SpindlePresetEditorState) => void): () => void {
  return trackPresetSubscription(subscribePresetEditorState(listener))
}


afterEach(() => {
  for (const unsubscribe of [...activeSubscriptions]) unsubscribe()
  expect(activeSubscriptions.size).toBe(0)
  setPresetEditorController(null)
})

describe('scoped preset editor helper', () => {
  test('clones Main fields and mutates only its identifier namespace', () => {
    let current = publishedDraft()
    let activeTab = 'preset'
    current.blocks[0]!.variables = [
      ...(current.blocks[0]!.variables ?? []),
      {
        id: 'modes-id',
        name: 'modes',
        label: 'Modes',
        type: 'multiselect',
        defaultValue: ['a'],
        options: [
          { id: 'a', label: 'A', value: 'a' },
          { id: 'b', label: 'B', value: 'b' },
        ],
      },
    ]
    const values: PromptVariableValuesDTO = {
      'sealed-block': { tone: 'neutral', modes: ['a', 'b'] },
    }
    setPresetEditorController({
      getState: (): SpindlePresetEditorState => ({
        open: true,
        presetId: current.id,
        activeTabId: activeTab,
        preset: current,
      }),
      getPromptVariableValues: () => values,
      setActiveTab(tabId) { activeTab = tabId },
      updatePreset(mutator) { current = mutator(current) },
      async flush() {},
    })

    const helper = createPresetEditorScopedHelper('fixture_extension', {
      assertActive() {},
      trackSubscription(unsubscribe) { return trackPresetSubscription(unsubscribe) },
    })

    const state = helper.getState()
    const publicBlock = state.blocks[0] as unknown as Record<string, unknown>
    for (const field of ['sealed', 'sealedKey', 'sealedSource', 'sealedOriginPresetId', 'sealedOriginVersion', 'sealedSha256']) {
      expect(publicBlock[field]).toBeUndefined()
    }
    expect(current.blocks[0]).toHaveProperty('sealed', true)
    expect(Object.getPrototypeOf(state.promptVariableValues)).toBeNull()
    ;(state.promptVariableValues as Record<string, Record<string, string | string[]>>)['sealed-block'].tone = 'changed locally'
    ;(state.promptVariableValues['sealed-block']!.modes as string[]).push('local')
    expect(values).toEqual({ 'sealed-block': { tone: 'neutral', modes: ['a', 'b'] } })
    expect(helper.getState().promptVariableValues).toEqual({
      'sealed-block': { tone: 'neutral', modes: ['a', 'b'] },
    })
    expect(current.metadata).toEqual({ another_extension: { preserved: true } })

    helper.setMetadata({ mode: 'parallel' }, { immediate: true })
    expect(current.metadata).toEqual({
      another_extension: { preserved: true },
      fixture_extension: { mode: 'parallel' },
    })

    helper.activateBuiltinTab('blocks')
    expect(activeTab).toBe('preset')
  })
  test('skips hostile sparse prompt arrays without touching getters or siblings', () => {
    const current = publishedDraft()
    current.blocks[0]!.variables = [
      ...(current.blocks[0]!.variables ?? []),
      {
        id: 'hostile-modes-id',
        name: 'modes',
        label: 'Modes',
        type: 'multiselect',
        defaultValue: ['kept'],
        options: [{ id: 'kept', label: 'Kept', value: 'kept' }],
      },
    ]
    let getterReads = 0
    const hostile = ['kept'] as unknown as string[]
    hostile.length = 2
    const hostilePrototype = Object.create(Array.prototype) as object
    Object.defineProperty(hostilePrototype, '1', {
      get() {
        getterReads += 1
        throw new Error('inherited prompt array getter was read')
      },
    })
    Object.setPrototypeOf(hostile, hostilePrototype)
    Object.defineProperty(hostile, 'extra', {
      enumerable: true,
      get() {
        getterReads += 1
        throw new Error('prompt array accessor was read')
      },
    })
    const symbolExtra = Symbol('extra')
    Object.defineProperty(hostile, symbolExtra, { enumerable: true, value: 'symbol' })
    const hostileOwnKeys = Reflect.ownKeys(hostile)
    const hostilePrototypeBefore = Object.getPrototypeOf(hostile)
    const hostileLengthBefore = Object.getOwnPropertyDescriptor(hostile, 'length')!
    const hostileIndexBefore = Object.getOwnPropertyDescriptor(hostile, '0')!
    const hostileExtraBefore = Object.getOwnPropertyDescriptor(hostile, 'extra')!
    const hostileDescriptors = hostileOwnKeys.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(hostile, key)!,
    ] as const)
    const values: PromptVariableValuesDTO = {
      'sealed-block': { tone: 'safe', modes: hostile },
    }
    setPresetEditorController({
      getState: (): SpindlePresetEditorState => ({
        open: true,
        presetId: current.id,
        activeTabId: 'preset',
        preset: current,
      }),
      getPromptVariableValues: () => values,
      setActiveTab() {},
      updatePreset() {},
      async flush() {},
    })
    const helper = createPresetEditorScopedHelper('fixture_extension', {
      assertActive() {},
      trackSubscription(unsubscribe) { return trackPresetSubscription(unsubscribe) },
    })
    const observed: SpindlePresetEditorExtensionState[] = []
    const unsubscribe = helper.onChange((state) => observed.push(state))

    expect(helper.getState().promptVariableValues).toEqual({ 'sealed-block': { tone: 'safe' } })
    expect(getterReads).toBe(0)
    syncPresetEditorState({
      open: true,
      presetId: current.id,
      activeTabId: 'preset',
      preset: current,
    }, values)
    expect(observed).toHaveLength(1)
    expect(observed[0]!.promptVariableValues).toEqual({ 'sealed-block': { tone: 'safe' } })
    expect(getterReads).toBe(0)
    expect(Reflect.ownKeys(hostile)).toEqual(hostileOwnKeys)
    expect(Object.getPrototypeOf(hostile)).toBe(hostilePrototypeBefore)
    const hostileLengthAfter = Object.getOwnPropertyDescriptor(hostile, 'length')!
    expect(hostileLengthAfter.value).toBe(hostileLengthBefore.value)
    expect(hostileLengthAfter.writable).toBe(hostileLengthBefore.writable)
    expect(Object.getOwnPropertyDescriptor(hostile, '0')!.value).toBe(hostileIndexBefore.value)
    expect(Object.getOwnPropertyDescriptor(hostile, 'extra')!.get).toBe(hostileExtraBefore.get)
    expect(Object.getOwnPropertyDescriptor(hostile, symbolExtra)!.value).toBe('symbol')
    for (const [key, descriptor] of hostileDescriptors) {
      expect(Object.getOwnPropertyDescriptor(hostile, key)).toEqual(descriptor)
    }
    unsubscribe()
  })
  test('bounds hostile proxy-array inspection before reading indexes', () => {
    const current = publishedDraft()
    current.blocks[0]!.variables = [
      ...(current.blocks[0]!.variables ?? []),
      {
        id: 'proxy-modes-id',
        name: 'modes',
        label: 'Modes',
        type: 'multiselect',
        defaultValue: ['kept'],
        options: [{ id: 'kept', label: 'Kept', value: 'kept' }],
      },
    ]
    const target: string[] = []
    target.length = 4_294_967_295
    let ownKeysTraps = 0
    let descriptorTraps = 0
    let getTraps = 0
    let iteratorTraps = 0
    const hostile = new Proxy(target, {
      ownKeys() {
        ownKeysTraps += 1
        return ['length']
      },
      getOwnPropertyDescriptor(source, key) {
        descriptorTraps += 1
        return Reflect.getOwnPropertyDescriptor(source, key)
      },
      get(source, key, receiver) {
        getTraps += 1
        if (key === Symbol.iterator) iteratorTraps += 1
        return Reflect.get(source, key, receiver)
      },
    })
    const values: PromptVariableValuesDTO = {
      'sealed-block': { tone: 'safe', modes: hostile },
    }
    setPresetEditorController({
      getState: (): SpindlePresetEditorState => ({
        open: true,
        presetId: current.id,
        activeTabId: 'preset',
        preset: current,
      }),
      getPromptVariableValues: () => values,
      setActiveTab() {},
      updatePreset() {},
      async flush() {},
    })
    const helper = createPresetEditorScopedHelper('fixture_extension', {
      assertActive() {},
      trackSubscription(unsubscribe) { return trackPresetSubscription(unsubscribe) },
    })
    const observed: SpindlePresetEditorExtensionState[] = []
    const unsubscribe = helper.onChange((state) => observed.push(state))

    expect(helper.getState().promptVariableValues).toEqual({ 'sealed-block': { tone: 'safe' } })
    syncPresetEditorState({
      open: true,
      presetId: current.id,
      activeTabId: 'preset',
      preset: current,
    }, values)
    expect(observed).toHaveLength(1)
    expect(observed[0]!.promptVariableValues).toEqual({ 'sealed-block': { tone: 'safe' } })
    expect(ownKeysTraps).toBeLessThanOrEqual(8)
    expect(descriptorTraps).toBeLessThanOrEqual(16)
    expect(getTraps).toBe(0)
    expect(iteratorTraps).toBe(0)
    expect(target.length).toBe(4_294_967_295)
    expect(Reflect.ownKeys(target)).toEqual(['length'])
    unsubscribe()
  })
  test('fails closed when the private prompt map ownKeys trap throws', () => {
    const current = publishedDraft()
    const target = Object.create(null) as Record<string, unknown>
    let ownKeysTraps = 0
    const values = new Proxy(target, {
      ownKeys() {
        ownKeysTraps += 1
        throw new Error('private prompt map ownKeys trap')
      },
    }) as PromptVariableValuesDTO
    setPresetEditorController({
      getState: (): SpindlePresetEditorState => ({
        open: true,
        presetId: current.id,
        activeTabId: 'preset',
        preset: current,
      }),
      getPromptVariableValues: () => values,
      setActiveTab() {},
      updatePreset() {},
      async flush() {},
    })
    const helper = createPresetEditorScopedHelper('fixture_extension', {
      assertActive() {},
      trackSubscription(unsubscribe) { return trackPresetSubscription(unsubscribe) },
    })
    const observed: SpindlePresetEditorExtensionState[] = []
    const unsubscribe = helper.onChange((state) => observed.push(state))

    expect(helper.getState().promptVariableValues).toEqual({})
    syncPresetEditorState({
      open: true,
      presetId: current.id,
      activeTabId: 'preset',
      preset: current,
    }, values)
    expect(observed).toHaveLength(1)
    expect(observed[0]!.promptVariableValues).toEqual({})
    expect(ownKeysTraps).toBeLessThanOrEqual(8)
    expect(Reflect.ownKeys(target)).toEqual([])
    unsubscribe()
  })
  test('skips throwing bucket proxies while retaining a valid sibling', () => {
    const current = publishedDraft()
    current.blocks[0]!.variables = [
      ...(current.blocks[0]!.variables ?? []),
      {
        id: 'offset-id',
        name: 'offset',
        label: 'Offset',
        type: 'number',
        defaultValue: 0,
      },
    ]
    const badOwnKeysTarget = Object.create(null) as Record<string, unknown>
    const badDescriptorTarget = Object.create(null) as Record<string, unknown>
    let badOwnKeysTraps = 0
    let badDescriptorTraps = 0
    const badOwnKeys = new Proxy(badOwnKeysTarget, {
      ownKeys() {
        badOwnKeysTraps += 1
        throw new Error('bucket ownKeys trap')
      },
    })
    const badDescriptor = new Proxy(badDescriptorTarget, {
      ownKeys() {
        badDescriptorTraps += 1
        return ['evil']
      },
      getOwnPropertyDescriptor() {
        badDescriptorTraps += 1
        throw new Error('bucket descriptor trap')
      },
    })
    const values = {
      'sealed-block': { tone: 'safe', offset: -0 },
      'bad-own-keys': badOwnKeys,
      'bad-descriptor': badDescriptor,
    } as unknown as PromptVariableValuesDTO
    setPresetEditorController({
      getState: (): SpindlePresetEditorState => ({
        open: true,
        presetId: current.id,
        activeTabId: 'preset',
        preset: current,
      }),
      getPromptVariableValues: () => values,
      setActiveTab() {},
      updatePreset() {},
      async flush() {},
    })
    const helper = createPresetEditorScopedHelper('fixture_extension', {
      assertActive() {},
      trackSubscription(unsubscribe) { return trackPresetSubscription(unsubscribe) },
    })
    const observed: SpindlePresetEditorExtensionState[] = []
    const unsubscribe = helper.onChange((state) => observed.push(state))

    expect(helper.getState().promptVariableValues).toEqual({ 'sealed-block': { tone: 'safe' } })
    syncPresetEditorState({
      open: true,
      presetId: current.id,
      activeTabId: 'preset',
      preset: current,
    }, values)
    expect(observed).toHaveLength(1)
    expect(observed[0]!.promptVariableValues).toEqual({ 'sealed-block': { tone: 'safe' } })
    expect(badOwnKeysTraps).toBeLessThanOrEqual(8)
    expect(badDescriptorTraps).toBeLessThanOrEqual(16)
    expect(Reflect.ownKeys(badOwnKeysTarget)).toEqual([])
    expect(Reflect.ownKeys(badDescriptorTarget)).toEqual([])
    unsubscribe()
  })
  test('keeps prompt values out of public drafts while exposing pruned scoped values', () => {
    let current = legacyDraft()
    const values: PromptVariableValuesDTO = {
      'sealed-block': { tone: 'warm', unknown: 'discarded' },
      orphan: { tone: 'discarded' },
    }
    current.blocks.push({ ...current.blocks[0], id: 'sealed-block-2' })
    setPresetEditorController({
      getState: (): SpindlePresetEditorState => ({
        open: true,
        presetId: current.id,
        activeTabId: 'preset',
        preset: current,
      }),
      getPromptVariableValues: () => values,
      setActiveTab() {},
      updatePreset(mutator) { current = mutator(current) },
      async flush() {},
    })
    const helper = createPresetEditorScopedHelper('fixture_extension', {
      assertActive() {},
      trackSubscription(unsubscribe) { return trackPresetSubscription(unsubscribe) },
    })
    const publicUpdates: SpindlePresetEditorState[] = []
    const publicReads: SpindlePresetEditorState[] = []
    const scopedUpdates: SpindlePresetEditorExtensionState[] = []
    const unsubscribePublic = subscribeForTest((state) => {
      publicUpdates.push(state)
      publicReads.push(getPresetEditorState())
    })
    const unsubscribeScoped = helper.onChange((state) => scopedUpdates.push(state))

    syncPresetEditorState({
      open: true,
      presetId: current.id,
      activeTabId: 'preset',
      preset: current,
    }, values)

    const publicRead = publicReads.at(-1)!
    expect(Object.hasOwn(publicRead.preset!, 'promptVariables')).toBe(false)
    expect(Object.hasOwn(publicRead.preset!.metadata, 'promptVariables')).toBe(false)
    const publicState = getPresetEditorState()
    expect(Object.hasOwn(publicState.preset!, 'promptVariables')).toBe(false)
    expect(Object.hasOwn(publicState.preset!.metadata, 'promptVariables')).toBe(false)
    const publicUpdate = publicUpdates.at(-1)!
    expect(Object.hasOwn(publicUpdate.preset!, 'promptVariables')).toBe(false)
    expect(Object.hasOwn(publicUpdate.preset!.metadata, 'promptVariables')).toBe(false)
    const scopedState = helper.getState()
    expect(Object.hasOwn(scopedState, 'promptVariables')).toBe(false)
    expect(Object.hasOwn(scopedUpdates[0]!, 'promptVariables')).toBe(false)
    for (const scoped of [scopedState, scopedUpdates[0]!]) {
      for (const block of scoped.blocks) {
        for (const field of ['sealed', 'sealedKey', 'sealedSource', 'sealedOriginPresetId', 'sealedOriginVersion', 'sealedSha256']) {
          expect((block as unknown as Record<string, unknown>)[field]).toBeUndefined()
        }
      }
    }
    expect(scopedState.promptVariableValues).toEqual({ 'sealed-block': { tone: 'warm' } })
    expect(scopedUpdates[0]!.promptVariableValues).toEqual({ 'sealed-block': { tone: 'warm' } })
    unsubscribeScoped()
    unsubscribePublic()
  })
  test('unions variable definitions across duplicate block ids before pruning values', () => {
    const current = publishedDraft()
    const base = { ...current.blocks[0], sealed: false } as typeof current.blocks[0] & Record<string, unknown>
    current.blocks = [
      {
        ...base,
        id: 'duplicate',
        variables: [
          {
            id: 'tone-id',
            name: 'tone',
            label: 'Tone',
            type: 'text' as const,
            defaultValue: '',
          },
          {
            id: 'style-id',
            name: 'style',
            label: 'Style',
            type: 'text' as const,
            defaultValue: '',
          },
        ],
      },
      {
        ...base,
        id: 'duplicate',
        variables: [{
          id: 'tone-number-id',
          name: 'tone',
          label: 'Tone',
          type: 'number' as const,
          defaultValue: 0,
        }],
      },
    ]
    const values: PromptVariableValuesDTO = {
      duplicate: { tone: 42, style: 'keep', stale: 'drop', invalid: 99 },
    }
    setPresetEditorController({
      getState: (): SpindlePresetEditorState => ({
        open: true,
        presetId: current.id,
        activeTabId: 'preset',
        preset: current,
      }),
      getPromptVariableValues: () => values,
      setActiveTab() {},
      updatePreset() {},
      async flush() {},
    })
    const helper = createPresetEditorScopedHelper('fixture_extension', {
      assertActive() {},
      trackSubscription(unsubscribe) { return trackPresetSubscription(unsubscribe) },
    })

    expect(helper.getState().promptVariableValues).toEqual({
      duplicate: { tone: 42, style: 'keep' },
    })
  })

  test('publishes current private values before delivering callbacks', () => {
    let current = publishedDraft()
    current.blocks[0]!.variables = [
      ...(current.blocks[0]!.variables ?? []),
      {
        id: 'callback-modes-id',
        name: 'modes',
        label: 'Modes',
        type: 'multiselect',
        defaultValue: ['a'],
        options: [
          { id: 'a', label: 'A', value: 'a' },
          { id: 'b', label: 'B', value: 'b' },
        ],
      },
    ]
    let values: PromptVariableValuesDTO = {
      'sealed-block': { tone: 'old', modes: ['a', 'b'] },
    }
    setPresetEditorController({
      getState: (): SpindlePresetEditorState => ({
        open: true,
        presetId: current.id,
        activeTabId: 'preset',
        preset: current,
      }),
      getPromptVariableValues: () => values,
      setActiveTab() {},
      updatePreset(mutator) { current = mutator(current) },
      async flush() {},
    })
    const helper = createPresetEditorScopedHelper('fixture_extension', {
      assertActive() {},
      trackSubscription(unsubscribe) { return trackPresetSubscription(unsubscribe) },
    })
    const callbackValues: unknown[] = []
    const unsubscribe = helper.onChange((state) => {
      const event = structuredClone(state.promptVariableValues)
      ;(state.promptVariableValues['sealed-block']!.modes as string[]).push('callback-local')
      callbackValues.push({
        event,
        read: helper.getState().promptVariableValues,
      })
    })
    const callbackBValues: unknown[] = []
    const unsubscribeB = helper.onChange((state) => {
      callbackBValues.push({
        event: structuredClone(state.promptVariableValues),
        read: helper.getState().promptVariableValues,
      })
    })

    values = { 'sealed-block': { tone: 'new', modes: ['a', 'b'] } }
    syncPresetEditorState({
      open: true,
      presetId: current.id,
      activeTabId: 'preset',
      preset: current,
    }, values)

    expect(callbackValues).toEqual([{
      event: { 'sealed-block': { tone: 'new', modes: ['a', 'b'] } },
      read: { 'sealed-block': { tone: 'new', modes: ['a', 'b'] } },
    }])
    expect(callbackBValues).toEqual([{
      event: { 'sealed-block': { tone: 'new', modes: ['a', 'b'] } },
      read: { 'sealed-block': { tone: 'new', modes: ['a', 'b'] } },
    }])
    expect(values).toEqual({ 'sealed-block': { tone: 'new', modes: ['a', 'b'] } })
    expect(helper.getState().promptVariableValues).toEqual({
      'sealed-block': { tone: 'new', modes: ['a', 'b'] },
    })
    unsubscribeB()
    unsubscribeB()
    unsubscribe()
    unsubscribe()
  })

  test('resets private values on close and between selected presets', () => {
    let current = publishedDraft('preset-a')
    let open = true
    let values: PromptVariableValuesDTO = { 'sealed-block': { tone: 'A' } }
    setPresetEditorController({
      getState: (): SpindlePresetEditorState => ({
        open,
        presetId: open ? current.id : null,
        activeTabId: 'preset',
        preset: open ? current : null,
      }),
      getPromptVariableValues: () => values,
      setActiveTab() {},
      updatePreset(mutator) { current = mutator(current) },
      async flush() {},
    })
    const helper = createPresetEditorScopedHelper('fixture_extension', {
      assertActive() {},
      trackSubscription(unsubscribe) { return trackPresetSubscription(unsubscribe) },
    })
    const observed: Array<{ presetId: string | null; open: boolean; values: unknown }> = []
    const unsubscribe = helper.onChange((state) => {
      observed.push({ presetId: state.presetId, open: state.open, values: state.promptVariableValues })
    })

    syncPresetEditorState({
      open: true,
      presetId: 'preset-a',
      activeTabId: 'preset',
      preset: current,
    }, values)
    current = publishedDraft('preset-b')
    values = {}
    syncPresetEditorState({
      open: true,
      presetId: 'preset-b',
      activeTabId: 'preset',
      preset: current,
    })
    values = { 'sealed-block': { tone: 'B' } }
    syncPresetEditorState({
      open: true,
      presetId: 'preset-b',
      activeTabId: 'preset',
      preset: current,
    }, values)
    open = false
    values = {}
    syncPresetEditorState({
      open: false,
      presetId: null,
      activeTabId: 'preset',
      preset: null,
    })
    expect(helper.getState()).toMatchObject({
      open: false,
      presetId: null,
      promptVariableValues: {},
    })
    values = { 'sealed-block': { tone: 'stale-after-close' } }
    expect(helper.getState().promptVariableValues).toEqual({})
    values = {}
    current = publishedDraft('preset-c')
    open = true
    syncPresetEditorState({
      open: true,
      presetId: 'preset-c',
      activeTabId: 'preset',
      preset: current,
    })

    expect(observed).toEqual([
      { presetId: 'preset-a', open: true, values: { 'sealed-block': { tone: 'A' } } },
      { presetId: null, open: false, values: {} },
      { presetId: 'preset-b', open: true, values: {} },
      { presetId: 'preset-b', open: true, values: { 'sealed-block': { tone: 'B' } } },
      { presetId: null, open: false, values: {} },
      { presetId: 'preset-c', open: true, values: {} },
    ])
    unsubscribe()
  })

  test('reads private values from the current controller state', () => {
    let current = publishedDraft()
    let values: PromptVariableValuesDTO = { 'sealed-block': { tone: 'first' } }
    setPresetEditorController({
      getState: (): SpindlePresetEditorState => ({
        open: true,
        presetId: current.id,
        activeTabId: 'preset',
        preset: current,
      }),
      getPromptVariableValues: () => values,
      setActiveTab() {},
      updatePreset() {},
      async flush() {},
    })
    const helper = createPresetEditorScopedHelper('fixture_extension', {
      assertActive() {},
      trackSubscription(unsubscribe) { return trackPresetSubscription(unsubscribe) },
    })

    expect(helper.getState().promptVariableValues).toEqual({ 'sealed-block': { tone: 'first' } })
    values = { 'sealed-block': { tone: 'second' } }
    expect(helper.getState().promptVariableValues).toEqual({ 'sealed-block': { tone: 'second' } })
  })

  test('passes a published draft without private values to mutators', () => {
    let current = legacyDraft()
    const values: PromptVariableValuesDTO = { 'sealed-block': { tone: 'private' } }
    let received: SpindlePresetEditorDraft | null = null
    setPresetEditorController({
      getState: (): SpindlePresetEditorState => ({
        open: true,
        presetId: current.id,
        activeTabId: 'preset',
        preset: current,
      }),
      getPromptVariableValues: () => values,
      setActiveTab() {},
      updatePreset(mutator) {
        const next = mutator(current)
        received = next
        current = next
      },
      async flush() {},
    })

    updatePresetEditorDraft((published) => {
      expect(Object.hasOwn(published, 'promptVariables')).toBe(false)
      expect(Object.hasOwn(published.metadata, 'promptVariables')).toBe(false)
      return published
    })

    expect(received).not.toBeNull()
    expect(Object.hasOwn(received!, 'promptVariables')).toBe(false)
    expect(Object.hasOwn(received!.metadata, 'promptVariables')).toBe(false)
    expect(Object.hasOwn(current, 'promptVariables')).toBe(false)
    expect(Object.hasOwn(current.metadata, 'promptVariables')).toBe(false)
    expect(values).toEqual({ 'sealed-block': { tone: 'private' } })
  })
  test('publishes scoped onChange updates through the tracked disposer path', () => {
    const current = publishedDraft()
    const values: PromptVariableValuesDTO = { 'sealed-block': { tone: 'neutral' } }
    setPresetEditorController({
      getState: (): SpindlePresetEditorState => ({
        open: true,
        presetId: current.id,
        activeTabId: 'preset',
        preset: current,
      }),
      getPromptVariableValues: () => values,
      setActiveTab() {},
      updatePreset() {},
      async flush() {},
    })

    const helper = createPresetEditorScopedHelper('fixture_extension', {
      assertActive() {},
      trackSubscription(unsubscribe) { return trackPresetSubscription(unsubscribe) },
    })
    const publicObserved: SpindlePresetEditorState[] = []
    const unsubscribePublic = subscribeForTest((state) => publicObserved.push(state))
    const observed: Array<Pick<SpindlePresetEditorExtensionState, 'activeTabId' | 'promptVariableValues'>> = []
    const subscriptionsBefore = activeSubscriptions.size
    const unsubscribe = helper.onChange((state) => observed.push({
      activeTabId: state.activeTabId,
      promptVariableValues: state.promptVariableValues,
    }))
    expect(activeSubscriptions.size).toBe(subscriptionsBefore + 1)

    syncPresetEditorState({
      open: true,
      presetId: current.id,
      activeTabId: 'blocks',
      preset: current,
    }, values)

    expect(observed).toEqual([{
      activeTabId: 'blocks',
      promptVariableValues: { 'sealed-block': { tone: 'neutral' } },
    }])
    expect(publicObserved).toHaveLength(1)
    unsubscribePublic()
    expect(activeSubscriptions.size).toBe(subscriptionsBefore)
    unsubscribePublic()
    expect(activeSubscriptions.size).toBe(subscriptionsBefore)
    const scopedBeforePublicRemoval = observed.length
    syncPresetEditorState({
      open: true,
      presetId: current.id,
      activeTabId: 'after-public',
      preset: current,
    }, values)
    expect(observed).toHaveLength(scopedBeforePublicRemoval + 1)
    expect(publicObserved).toHaveLength(1)

    unsubscribe()
    expect(activeSubscriptions.size).toBe(subscriptionsBefore - 1)
    unsubscribe()
    expect(activeSubscriptions.size).toBe(subscriptionsBefore - 1)
    const scopedAfterCleanup = observed.length
    syncPresetEditorState({
      open: true,
      presetId: current.id,
      activeTabId: 'after-both',
      preset: current,
    }, values)
    expect(observed).toHaveLength(scopedAfterCleanup)
    expect(publicObserved).toHaveLength(1)

    const publicObservedSecond: SpindlePresetEditorState[] = []
    const unsubscribePublicSecond = subscribeForTest((state) => publicObservedSecond.push(state))
    const scopedObservedSecond: SpindlePresetEditorExtensionState[] = []
    const unsubscribeScopedSecond = helper.onChange((state) => scopedObservedSecond.push(state))
    const pairTwoSubscriptions = activeSubscriptions.size
    unsubscribeScopedSecond()
    expect(activeSubscriptions.size).toBe(pairTwoSubscriptions - 1)
    unsubscribeScopedSecond()
    expect(activeSubscriptions.size).toBe(pairTwoSubscriptions - 1)
    syncPresetEditorState({
      open: true,
      presetId: current.id,
      activeTabId: 'after-scoped',
      preset: current,
    }, values)
    expect(publicObservedSecond).toHaveLength(1)
    expect(scopedObservedSecond).toHaveLength(0)
    unsubscribePublicSecond()
    expect(activeSubscriptions.size).toBe(pairTwoSubscriptions - 2)
    unsubscribePublicSecond()
    expect(activeSubscriptions.size).toBe(pairTwoSubscriptions - 2)
    syncPresetEditorState({
      open: true,
      presetId: current.id,
      activeTabId: 'after-public-second',
      preset: current,
    }, values)
    expect(publicObservedSecond).toHaveLength(1)
  })
  test('reads prompt-variable values from the private controller channel', () => {
    const current = publishedDraft()
    const values: PromptVariableValuesDTO = { 'sealed-block': { tone: 'top-level' } }
    setPresetEditorController({
      getState: (): SpindlePresetEditorState => ({
        open: true,
        presetId: current.id,
        activeTabId: 'preset',
        preset: current,
      }),
      getPromptVariableValues: () => values,
      setActiveTab() {},
      updatePreset() {},
      async flush() {},
    })
    const helper = createPresetEditorScopedHelper('fixture_extension', {
      assertActive() {},
      trackSubscription(unsubscribe) { return trackPresetSubscription(unsubscribe) },
    })

    expect(helper.getState().promptVariableValues).toEqual({
      'sealed-block': { tone: 'top-level' },
    })
  })

  test('preserves prototype-sensitive prompt variable keys in null-prototype maps', () => {
    const current = publishedDraft()
    const promptVariableValues = Object.create(null) as Record<string, Record<string, string>>
    const bucket = Object.create(null) as Record<string, string>
    for (const name of ['__proto__', 'constructor', 'toString']) {
      Object.defineProperty(bucket, name, {
        value: name,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    Object.defineProperty(promptVariableValues, 'sealed-block', {
      value: bucket,
      enumerable: true,
      configurable: true,
      writable: true,
    })
    current.blocks[0]!.variables = ['__proto__', 'constructor', 'toString'].map((name, index) => ({
      id: `prototype-${index}`,
      name,
      label: name,
      type: 'text' as const,
      defaultValue: '',
    }))
    setPresetEditorController({
      getState: (): SpindlePresetEditorState => ({
        open: true,
        presetId: current.id,
        activeTabId: 'preset',
        preset: current,
      }),
      getPromptVariableValues: () => promptVariableValues,
      setActiveTab() {},
      updatePreset() {},
      async flush() {},
    })
    const helper = createPresetEditorScopedHelper('fixture_extension', {
      assertActive() {},
      trackSubscription(unsubscribe) { return trackPresetSubscription(unsubscribe) },
    })

    const state = helper.getState()
    const output = state.promptVariableValues as Record<string, Record<string, string>>
    expect(Object.getPrototypeOf(output)).toBeNull()
    expect(Object.getPrototypeOf(output['sealed-block'])).toBeNull()
    for (const name of ['__proto__', 'constructor', 'toString']) {
      expect(Object.hasOwn(output['sealed-block']!, name)).toBe(true)
      expect(output['sealed-block']![name]).toBe(name)
    }
  })

  test('rejects a retained helper after the controller closes during a preset switch', () => {
    let current = draft()
    let open = true
    setPresetEditorController({
      getState: (): SpindlePresetEditorState => ({
        open,
        presetId: open ? current.id : null,
        activeTabId: 'preset',
        preset: open ? current : null,
      }),
      setActiveTab() {},
      updatePreset(mutator) { current = mutator(current) },
      async flush() {},
    })
    const helper = createPresetEditorScopedHelper('fixture_extension', {
      assertActive() {},
      trackSubscription(unsubscribe) { return trackPresetSubscription(unsubscribe) },
    })

    open = false
    expect(() => helper.setMetadata({ mode: 'stale' })).toThrow('PRESET_EDITOR_CLOSED')
    expect(current.metadata.fixture_extension).toBeUndefined()
  })

  test('publishes a closed state before exposing the next selected preset', () => {
    const observed: SpindlePresetEditorState[] = []
    const unsubscribe = subscribeForTest((state) => observed.push(state))

    const first = draft()
    syncPresetEditorState({
      open: true,
      presetId: first.id,
      activeTabId: 'preset',
      preset: first,
    })
    const next = { ...draft(), id: 'preset-2' }
    syncPresetEditorState({
      open: true,
      presetId: next.id,
      activeTabId: 'preset',
      preset: next,
    })

    expect(observed).toHaveLength(3)
    expect(observed[0]).toMatchObject({ open: true, presetId: 'preset-1' })
    expect(observed[1]).toMatchObject({ open: false, presetId: null, preset: null })
    expect(observed[2]).toMatchObject({ open: true, presetId: 'preset-2' })
    unsubscribe()
  })

  test('makes a synthetic close authoritative while notifying listeners', () => {
    const first = draft()
    const next = { ...draft(), id: 'preset-2' }
    let updates = 0
    setPresetEditorController({
      getState: (): SpindlePresetEditorState => ({
        open: true,
        presetId: next.id,
        activeTabId: 'preset',
        preset: next,
      }),
      setActiveTab() {},
      updatePreset() { updates += 1 },
      async flush() {},
    })
    syncPresetEditorState({
      open: true,
      presetId: first.id,
      activeTabId: 'preset',
      preset: first,
    })
    const helper = createPresetEditorScopedHelper('fixture_extension', {
      assertActive() {},
      trackSubscription(unsubscribe) { return trackPresetSubscription(unsubscribe) },
    })
    const readsDuringClose: SpindlePresetEditorState[] = []
    let closeMutationError: unknown
    let closeTabError: unknown
    const unsubscribe = subscribeForTest((state) => {
      if (state.open) return
      readsDuringClose.push(getPresetEditorState())
      try {
        helper.setMetadata({ mode: 'stale' })
      } catch (error) {
        closeMutationError = error
      }
      try {
        helper.activateBuiltinTab('blocks')
      } catch (error) {
        closeTabError = error
      }
    })

    syncPresetEditorState({
      open: true,
      presetId: next.id,
      activeTabId: 'preset',
      preset: next,
    })

    expect(readsDuringClose).toEqual([expect.objectContaining({ open: false, presetId: null, preset: null })])
    expect(closeMutationError).toBeInstanceOf(Error)
    expect((closeMutationError as Error).message).toContain('PRESET_EDITOR_CLOSED')
    expect(closeTabError).toBeInstanceOf(Error)
    expect((closeTabError as Error).message).toContain('PRESET_EDITOR_CLOSED')
    expect(updates).toBe(0)
    unsubscribe()
  })

  test('rejects non-JSON extension metadata before it reaches coordinator state', () => {
    const helper = createPresetEditorScopedHelper('fixture_extension', {
      assertActive() {},
      trackSubscription(unsubscribe) { return trackPresetSubscription(unsubscribe) },
    })

    expect(() => helper.setMetadata(new Map() as unknown as Record<string, unknown>))
      .toThrow('PRESET_EDITOR_INVALID_METADATA')
    expect(() => helper.setMetadata({ nested: { count: BigInt(1) } } as unknown as Record<string, unknown>))
      .toThrow('PRESET_EDITOR_INVALID_METADATA')
    expect(() => helper.setMetadata({ callback: () => {} } as unknown as Record<string, unknown>))
      .toThrow('PRESET_EDITOR_INVALID_METADATA')
  })

  test('does not republish an obsolete controller after an in-flight flush', async () => {
    const current = draft()
    let resolveFlush!: () => void
    const pendingFlush = new Promise<void>((resolve) => { resolveFlush = resolve })
    setPresetEditorController({
      getState: (): SpindlePresetEditorState => ({
        open: true,
        presetId: current.id,
        activeTabId: 'preset',
        preset: current,
      }),
      setActiveTab() {},
      updatePreset() {},
      flush: () => pendingFlush,
    })
    const observed: SpindlePresetEditorState[] = []
    const unsubscribe = subscribeForTest((state) => observed.push(state))

    const flush = flushPresetEditorDraft()
    setPresetEditorController(null)
    resolveFlush()
    await flush

    expect(getPresetEditorState()).toMatchObject({ open: false, presetId: null, preset: null })
    expect(observed).toEqual([expect.objectContaining({ open: false, presetId: null, preset: null })])
    unsubscribe()
  })

  test('rejects extension identifiers that collide with Loom-owned metadata', () => {
    expect(() => createPresetEditorScopedHelper('source', {
      assertActive() {},
      trackSubscription(unsubscribe) { return trackPresetSubscription(unsubscribe) },
    })).toThrow('PRESET_EDITOR_RESERVED_METADATA_KEY')
    expect(() => createPresetEditorScopedHelper('description', {
      assertActive() {},
      trackSubscription(unsubscribe) { return trackPresetSubscription(unsubscribe) },
    })).toThrow('PRESET_EDITOR_RESERVED_METADATA_KEY')
    expect(() => createPresetEditorScopedHelper('_lumiverse_extension', {
      assertActive() {},
      trackSubscription(unsubscribe) { return trackPresetSubscription(unsubscribe) },
    })).toThrow('PRESET_EDITOR_RESERVED_METADATA_KEY')
  })

  test('rejects use after a permission revocation invalidates access', () => {
    let active = false
    const helper = createPresetEditorScopedHelper('fixture_extension', {
      assertActive() {
        if (!active) throw new Error('PRESET_EDITOR_REVOKED')
      },
      trackSubscription(unsubscribe) { return trackPresetSubscription(unsubscribe) },
    })

    expect(() => helper.getState()).toThrow('PRESET_EDITOR_REVOKED')
    active = true
    expect(() => helper.setMetadata({ mode: 'single' })).toThrow('PRESET_EDITOR_CLOSED')
  })

  test('invalidates retained helpers while allowing a newly acquired helper after regrant', () => {
    let current = draft()
    let permissions = ['presets']
    setPresetEditorController({
      getState: (): SpindlePresetEditorState => ({
        open: true,
        presetId: current.id,
        activeTabId: 'preset',
        preset: current,
      }),
      setActiveTab() {},
      updatePreset(mutator) { current = mutator(current) },
      async flush() {},
    })
    const access = createPresetEditorAccess(
      'fixture_extension',
      () => permissions,
      (unsubscribe) => unsubscribe,
    )

    const retained = access.acquire()
    permissions = []
    access.revoke()
    expect(() => access.acquire()).toThrow('PERMISSION_DENIED:presets')
    permissions = ['presets']
    expect(() => retained.setMetadata({ mode: 'stale' })).toThrow('PRESET_EDITOR_REVOKED')

    const reacquired = access.acquire()
    reacquired.setMetadata({ mode: 'parallel' })
    expect(current.metadata.fixture_extension).toEqual({ mode: 'parallel' })

  })
  test('permanently invalidates helpers when the extension frontend unloads', () => {
    const access = createPresetEditorAccess(
      'fixture_extension',
      () => ['presets'],
      (unsubscribe) => unsubscribe,
    )
    const retained = access.acquire()
    access.dispose()

    expect(() => access.acquire()).toThrow('PRESET_EDITOR_DISPOSED')
    expect(() => retained.getState()).toThrow('PRESET_EDITOR_DISPOSED')
  })
})
