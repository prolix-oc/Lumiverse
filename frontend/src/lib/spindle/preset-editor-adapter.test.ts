import { describe, expect, test } from 'bun:test'
import { createNewLoomPreset, marshalUpdate } from '@/lib/loom/service'
import { applyPresetEditorDraft, toPresetEditorDraft } from './preset-editor-adapter'
import type { SpindlePresetEditorDraft } from './preset-editor-types'

describe('preset editor draft adapter', () => {
  test('applies extension metadata while retaining native preset fields', () => {
    const current = createNewLoomPreset('Original', 'Native description')
    const draft = toPresetEditorDraft(current)
    draft.metadata.fixture_extension = { mode: 'multi' }
    draft.blocks[0].content = 'Updated by extension'

    const next = applyPresetEditorDraft(current, draft)
    const raw = marshalUpdate(next)
    expect(next.description).toBe('Native description')
    expect(next.blocks[0].content).toBe('Updated by extension')
    expect(raw.metadata?.fixture_extension).toEqual({ mode: 'multi' })
  })

  test('accepts published drafts without promptVariables and reconciles current values', () => {
    const current = createNewLoomPreset('Published-shape source')
    const block = current.blocks[0]!
    block.variables = [{
      id: 'tone-variable',
      name: 'tone',
      label: 'Tone',
      type: 'text',
      defaultValue: 'neutral',
    }]
    current.promptVariables = {
      [block.id]: { tone: 'existing value' },
    }

    const draft = toPresetEditorDraft(current)
    expect(Object.hasOwn(draft, 'promptVariables')).toBe(false)
    draft.name = 'Published-shape update'

    const next = applyPresetEditorDraft(current, draft)
    const persisted = marshalUpdate(next)

    expect(next.name).toBe('Published-shape update')
    expect(next.promptVariables).toEqual({
      [block.id]: { tone: 'existing value' },
    })
    expect(persisted.metadata?.promptVariables).toEqual({
      [block.id]: { tone: 'existing value' },
    })
  })

  test('strips sealed provenance from outbound drafts and only restores it by stable ID', () => {
    const current = createNewLoomPreset('Sealed source')
    current.cacheRevision = 41
    const firstSealedFields = {
      sealed: true,
      sealedKey: 'hub-key-first',
      sealedSource: 'lumihub',
      sealedOriginPresetId: 'origin-first',
      sealedOriginVersion: 'v3-first',
      sealedSha256: 'sha256:first',
    }
    const secondSealedFields = {
      sealed: true,
      sealedKey: 'hub-key-second',
      sealedSource: 'lumihub',
      sealedOriginPresetId: 'origin-second',
      sealedOriginVersion: 'v4-second',
      sealedSha256: 'sha256:second',
    }
    const forgedSealedFields = {
      sealed: true,
      sealedKey: 'forged-key',
      sealedSource: 'forged',
      sealedOriginPresetId: 'forged-origin',
      sealedOriginVersion: 'forged-version',
      sealedSha256: 'sha256:forged',
    }
    current.blocks = [
      { ...current.blocks[0]!, id: 'sealed-first', name: 'Shared', ...firstSealedFields },
      { ...current.blocks[0]!, id: 'sealed-second', name: 'Shared', ...secondSealedFields },
    ]

    const draft = toPresetEditorDraft(current)
    const firstDraftBlock = draft.blocks[0]!
    const secondDraftBlock = draft.blocks[1]!
    for (const draftBlock of draft.blocks) {
      for (const key of Object.keys(firstSealedFields)) {
        expect(Object.hasOwn(draftBlock, key)).toBe(false)
      }
    }

    const forgedNewBlock = {
      ...firstDraftBlock,
      ...forgedSealedFields,
      id: 'new-block',
      name: 'Shared',
    }
    draft.blocks = [forgedNewBlock, secondDraftBlock, firstDraftBlock]
    const next = applyPresetEditorDraft(current, draft)

    expect(next.cacheRevision).toBe(41)
    expect(next.blocks.map((block) => block.id)).toEqual(['new-block', 'sealed-second', 'sealed-first'])
    expect(Object.fromEntries(
      Object.keys(secondSealedFields).map((key) => [key, (next.blocks[1] as unknown as Record<string, unknown>)[key]]),
    )).toEqual(secondSealedFields)
    expect(Object.fromEntries(
      Object.keys(firstSealedFields).map((key) => [key, (next.blocks[2] as unknown as Record<string, unknown>)[key]]),
    )).toEqual(firstSealedFields)
    for (const key of Object.keys(forgedSealedFields)) {
      expect(Object.hasOwn(next.blocks[0]!, key)).toBe(false)
    }
  })

  test('rejects changing the draft identity', () => {
    const current = createNewLoomPreset('Original')
    const draft = toPresetEditorDraft(current)
    draft.id = 'different'
    expect(() => applyPresetEditorDraft(current, draft)).toThrow('id cannot be changed')
  })
  test('rejects accessor-backed draft fields before invoking their getters', () => {
    const current = createNewLoomPreset('Accessor source')
    const draft = toPresetEditorDraft(current)
    let getterInvoked = false
    Object.defineProperty(draft, 'name', {
      configurable: true,
      enumerable: true,
      get() {
        getterInvoked = true
        return 'Getter must not run'
      },
    })

    expect(() => applyPresetEditorDraft(current, draft)).toThrow()
    expect(getterInvoked).toBe(false)
    expect(current.name).toBe('Accessor source')
  })

  test('rejects nested variable accessors before invoking their getters', () => {
    const current = createNewLoomPreset('Nested accessor source')
    current.blocks[0]!.variables = [{
      id: 'style-id',
      name: 'style',
      label: 'Style',
      type: 'select',
      defaultValue: 'formal',
      options: [{ id: 'formal', label: 'Formal', value: 'formal' }],
    }]
    const draft = toPresetEditorDraft(current)
    const variable = draft.blocks[0]!.variables![0]!
    const options = Reflect.get(variable, 'options')
    if (!Array.isArray(options) || options.length !== 1 || !options[0] || typeof options[0] !== 'object') {
      throw new Error('Nested accessor test setup failed')
    }
    let getterInvoked = false
    Object.defineProperty(options[0], 'value', {
      configurable: true,
      enumerable: true,
      get() {
        getterInvoked = true
        return 'Getter must not run'
      },
    })

    expect(() => applyPresetEditorDraft(current, draft)).toThrow()
    expect(getterInvoked).toBe(false)
    expect(current.blocks[0]!.variables?.[0]?.defaultValue).toBe('formal')
  })

  test('rejects custom prototypes and unknown public keys atomically', () => {
    const cases = [
      {
        label: 'custom draft prototype',
        mutate(draft: SpindlePresetEditorDraft) {
          Object.setPrototypeOf(draft, { inherited: true })
        },
      },
      {
        label: 'unknown draft key',
        mutate(draft: SpindlePresetEditorDraft) {
          Reflect.set(draft, 'unknownPublicKey', true)
        },
      },
      {
        label: 'unknown promptVariables key',
        mutate(draft: SpindlePresetEditorDraft) {
          const draftRecord = draft as unknown as Record<string, unknown>
          draftRecord.promptVariables = { unexpected: { value: 'must reject' } }
        },
      },
      {
        label: 'unknown block key',
        mutate(draft: SpindlePresetEditorDraft) {
          Reflect.set(draft.blocks[0]!, 'unknownPublicKey', true)
        },
      },
      {
        label: 'custom variable prototype',
        mutate(draft: SpindlePresetEditorDraft) {
          const variable = draft.blocks[0]!.variables![0]!
          Object.setPrototypeOf(variable, { inherited: true })
        },
      },
    ]

    for (const { label, mutate } of cases) {
      const current = createNewLoomPreset(`Unknown key source: ${label}`)
      current.blocks[0]!.variables = [{
        id: 'nested-id',
        name: 'nested',
        label: 'Nested',
        type: 'text',
        defaultValue: '',
      }]
      const before = marshalUpdate(current)
      const draft = toPresetEditorDraft(current)
      mutate(draft)

      expect(() => applyPresetEditorDraft(current, draft), label).toThrow()
      expect(marshalUpdate(current)).toEqual(before)
    }
  })

  test('rejects malformed Loom block schema atomically', () => {
    const current = createNewLoomPreset('Malformed schema source')
    const before = marshalUpdate(current)
    const draft = toPresetEditorDraft(current)
    Object.defineProperty(draft.blocks[0]!, 'role', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: 'not-a-role',
    })

    expect(() => applyPresetEditorDraft(current, draft)).toThrow()
    expect(marshalUpdate(current)).toEqual(before)
  })

  test('rejects newly duplicated block IDs atomically', () => {
    const current = createNewLoomPreset('Duplicate block source')
    current.blocks = [
      { ...current.blocks[0]!, id: 'block-first' },
      { ...current.blocks[1]!, id: 'block-second' },
    ]
    const before = marshalUpdate(current)
    const draft = toPresetEditorDraft(current)
    draft.blocks[1]!.id = draft.blocks[0]!.id

    expect(() => applyPresetEditorDraft(current, draft)).toThrow()
    expect(marshalUpdate(current)).toEqual(before)
  })
  test('rejects nested symbol keys atomically at every public draft level', () => {
    const symbol = Symbol('unexpected')
    const current = createNewLoomPreset('Nested symbol source')
    current.blocks[0]!.variables = [{
      id: 'choice-id',
      name: 'choice',
      label: 'Choice',
      type: 'select',
      defaultValue: 'one',
      options: [{ id: 'one', label: 'One', value: 'one' }],
    }]
    const cases: Array<{
      label: string
      mutate: (draft: SpindlePresetEditorDraft) => void
    }> = [
      {
        label: 'block',
        mutate: (draft) => Object.defineProperty(draft.blocks[0]!, symbol, {
          configurable: true,
          enumerable: true,
          value: 'unexpected',
        }),
      },
      {
        label: 'variable',
        mutate: (draft) => Object.defineProperty(draft.blocks[0]!.variables![0]!, symbol, {
          configurable: true,
          enumerable: true,
          value: 'unexpected',
        }),
      },
      {
        label: 'option',
        mutate: (draft) => {
          const variable = draft.blocks[0]!.variables![0]!
          if (variable.type !== 'select') throw new Error('Nested symbol test setup failed')
          Object.defineProperty(variable.options[0]!, symbol, {
            configurable: true,
            enumerable: true,
            value: 'unexpected',
          })
        },
      },
    ]

    for (const { label, mutate } of cases) {
      const draft = toPresetEditorDraft(current)
      mutate(draft)
      const before = marshalUpdate(current)

      expect(() => applyPresetEditorDraft(current, draft), label).toThrow()
      expect(marshalUpdate(current), label).toEqual(before)
    }
  })


  test('allows unrelated native edits beside unchanged legacy duplicate IDs but rejects new duplicates', () => {
    const current = createNewLoomPreset('Legacy native edit source')
    const base = current.blocks[0]!
    const privateFields = [
      ['sealed', true],
      ['sealedKey', 'first-key'],
      ['sealedSource', 'lumihub'],
      ['sealedOriginPresetId', 'first-origin'],
      ['sealedOriginVersion', 'v1'],
      ['sealedSha256', 'first-sha'],
    ] as const
    current.blocks = [
      Object.assign({ ...base, id: 'legacy-id', name: 'Legacy first' }, Object.fromEntries(privateFields)),
      Object.assign({ ...base, id: 'legacy-id', name: 'Legacy second' }, Object.fromEntries(privateFields.map(([key, value]) => [
        key,
        key === 'sealedKey' ? 'second-key' : key === 'sealedOriginPresetId' ? 'second-origin' : key === 'sealedOriginVersion' ? 'v2' : key === 'sealedSha256' ? 'second-sha' : value,
      ]))),
      { ...base, id: 'native-id', name: 'Native block' },
    ]
    const nativeDraft = toPresetEditorDraft(current)
    nativeDraft.blocks[2]!.name = 'Native edit'

    const next = applyPresetEditorDraft(current, nativeDraft)
    const nextBlocks = marshalUpdate(next).prompt_order!
    expect(nextBlocks.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'legacy-id', name: 'Legacy first' },
      { id: 'legacy-id', name: 'Legacy second' },
      { id: 'native-id', name: 'Native edit' },
    ])
    expect(nextBlocks.slice(0, 2).map((entry) => ({
      sealed: Reflect.get(entry, 'sealed'),
      sealedKey: Reflect.get(entry, 'sealedKey'),
      sealedSource: Reflect.get(entry, 'sealedSource'),
      sealedOriginPresetId: Reflect.get(entry, 'sealedOriginPresetId'),
      sealedOriginVersion: Reflect.get(entry, 'sealedOriginVersion'),
      sealedSha256: Reflect.get(entry, 'sealedSha256'),
    }))).toEqual([
      {
        sealed: true,
        sealedKey: 'first-key',
        sealedSource: 'lumihub',
        sealedOriginPresetId: 'first-origin',
        sealedOriginVersion: 'v1',
        sealedSha256: 'first-sha',
      },
      {
        sealed: true,
        sealedKey: 'second-key',
        sealedSource: 'lumihub',
        sealedOriginPresetId: 'second-origin',
        sealedOriginVersion: 'v2',
        sealedSha256: 'second-sha',
      },
    ])

    const before = structuredClone(current)
    const newDuplicate = toPresetEditorDraft(current)
    newDuplicate.blocks.push({ ...newDuplicate.blocks[2]!, id: 'legacy-id' })
    const newDuplicateBefore = structuredClone(newDuplicate)
    expect(() => applyPresetEditorDraft(current, newDuplicate)).toThrow()
    expect(current).toEqual(before)
    expect(newDuplicate).toEqual(newDuplicateBefore)
  })

  test('rejects duplicate occurrence deletion and reordering before private fields can transfer', () => {
    const current = createNewLoomPreset('Ambiguous occurrence source')
    const base = current.blocks[0]!
    current.blocks = [
      {
        ...base,
        id: 'duplicate-id',
        name: 'First occurrence',
        sealed: true,
        sealedKey: 'first-key',
        sealedSource: 'lumihub',
        sealedOriginPresetId: 'first-origin',
        sealedOriginVersion: 'v1',
        sealedSha256: 'first-sha',
      },
      {
        ...base,
        id: 'unrelated-id',
        name: 'Unrelated',
      },
      {
        ...base,
        id: 'duplicate-id',
        name: 'Second occurrence',
        sealed: true,
        sealedKey: 'second-key',
        sealedSource: 'lumihub',
        sealedOriginPresetId: 'second-origin',
        sealedOriginVersion: 'v2',
        sealedSha256: 'second-sha',
      },
    ]
    const before = structuredClone(current)
    const cases: Array<{
      label: string
      mutate: (draft: SpindlePresetEditorDraft) => void
    }> = [
      {
        label: 'reorder',
        mutate: (draft) => {
          const first = draft.blocks[0]!
          draft.blocks[0] = draft.blocks[2]!
          draft.blocks[2] = first
        },
      },
      {
        label: 'delete',
        mutate: (draft) => {
          draft.blocks = [draft.blocks[0]!, draft.blocks[1]!]
        },
      },
    ]

    for (const { label, mutate } of cases) {
      const draft = toPresetEditorDraft(current)
      mutate(draft)
      const draftBefore = structuredClone(draft)

      expect(() => applyPresetEditorDraft(current, draft), label)
        .toThrow('LOOM_AMBIGUOUS_BLOCK_OCCURRENCE')
      expect(current, label).toEqual(before)
      expect(draft, label).toEqual(draftBefore)
    }
  })

  test('omitting a block variables field clears its definitions and values', () => {
    const current = createNewLoomPreset('Variables omission source')
    const block = current.blocks[0]!
    block.variables = [{
      id: 'tone-id',
      name: 'tone',
      label: 'Tone',
      type: 'text',
      defaultValue: 'neutral',
    }]
    current.promptVariables = {
      [block.id]: { tone: 'saved value' },
    }
    const draft = toPresetEditorDraft(current)
    Reflect.deleteProperty(draft.blocks[0]!, 'variables')

    const next = applyPresetEditorDraft(current, draft)
    const persisted = marshalUpdate(next)

    expect(next.blocks[0]!.variables).toBeUndefined()
    expect(next.promptVariables).toEqual({})
    expect(persisted.metadata?.promptVariables).toEqual({})
    expect(Object.hasOwn(persisted.prompt_order?.[0]!, 'variables')).toBe(false)
  })

  test('metadata-only updates preserve unchanged legacy duplicate occurrences and sealed fields', () => {
    const current = createNewLoomPreset('Legacy duplicate source')
    const base = current.blocks[0]!
    const firstVariables = [
      { id: '', name: '', label: 'Legacy empty', type: 'text' as const, defaultValue: '' },
      { id: 'legacy-variable', name: 'legacy', label: 'Legacy duplicate', type: 'text' as const, defaultValue: 'first' },
    ]
    const secondVariables = [
      { id: '', name: '', label: 'Legacy empty', type: 'text' as const, defaultValue: '' },
      { id: 'legacy-variable', name: 'legacy', label: 'Legacy duplicate', type: 'text' as const, defaultValue: 'second' },
    ]
    current.blocks = [
      {
        ...base,
        id: 'legacy-block',
        variables: firstVariables,
        sealed: true,
        sealedKey: 'first-key',
        sealedSource: 'lumihub',
        sealedOriginPresetId: 'first-origin',
        sealedOriginVersion: 'v1',
        sealedSha256: 'first-sha',
      },
      {
        ...base,
        id: 'legacy-block',
        variables: secondVariables,
        sealed: true,
        sealedKey: 'second-key',
        sealedSource: 'lumihub',
        sealedOriginPresetId: 'second-origin',
        sealedOriginVersion: 'v2',
        sealedSha256: 'second-sha',
      },
    ]
    const draft = toPresetEditorDraft(current)
    draft.name = 'Legacy duplicate metadata update'

    const next = applyPresetEditorDraft(current, draft)
    const persistedBlocks = marshalUpdate(next).prompt_order!

    expect(next.name).toBe('Legacy duplicate metadata update')
    expect(persistedBlocks.map((block) => block.id)).toEqual(['legacy-block', 'legacy-block'])
    expect(persistedBlocks.map((block) => block.variables?.map((variable) => ({
      id: variable.id,
      name: variable.name,
      label: variable.label,
      defaultValue: variable.defaultValue,
    })))).toEqual([
      [
        { id: '', name: '', label: 'Legacy empty', defaultValue: '' },
        { id: 'legacy-variable', name: 'legacy', label: 'Legacy duplicate', defaultValue: 'first' },
      ],
      [
        { id: '', name: '', label: 'Legacy empty', defaultValue: '' },
        { id: 'legacy-variable', name: 'legacy', label: 'Legacy duplicate', defaultValue: 'second' },
      ],
    ])
    expect(Reflect.get(persistedBlocks[0]!, 'sealedKey')).toBe('first-key')
    expect(Reflect.get(persistedBlocks[1]!, 'sealedKey')).toBe('second-key')
    expect(Reflect.get(persistedBlocks[0]!, 'sealedOriginPresetId')).toBe('first-origin')
    expect(Reflect.get(persistedBlocks[1]!, 'sealedOriginPresetId')).toBe('second-origin')
    expect(Reflect.get(persistedBlocks[0]!, 'sealedSha256')).toBe('first-sha')
    expect(Reflect.get(persistedBlocks[1]!, 'sealedSha256')).toBe('second-sha')
  })

  test('rejects a newly invalid variable identity graph from a clean preset', () => {
    const current = createNewLoomPreset('New invalid identity source')
    current.blocks[0]!.variables = [
      { id: 'first-variable', name: 'first', label: 'First', type: 'text', defaultValue: '' },
      { id: 'second-variable', name: 'second', label: 'Second', type: 'text', defaultValue: '' },
    ]
    const before = marshalUpdate(current)
    const draft = toPresetEditorDraft(current)
    draft.blocks[0]!.variables![1]!.id = draft.blocks[0]!.variables![0]!.id

    expect(() => applyPresetEditorDraft(current, draft)).toThrow()
    expect(marshalUpdate(current)).toEqual(before)
  })

  test('rejects a new invalid variable identity in a changed duplicate-block occurrence', () => {
    const current = createNewLoomPreset('Mixed legacy identity source')
    const base = current.blocks[0]!
    current.blocks = [
      {
        ...base,
        id: 'duplicate-block',
        variables: [
          { id: '', name: '', label: 'Legacy empty', type: 'text', defaultValue: '' },
          { id: 'legacy-id', name: 'legacy', label: 'Legacy duplicate', type: 'text', defaultValue: '' },
        ],
      },
      {
        ...base,
        id: 'duplicate-block',
        variables: [
          { id: 'second-first', name: 'first', label: 'First', type: 'text', defaultValue: '' },
          { id: 'second-second', name: 'second', label: 'Second', type: 'text', defaultValue: '' },
        ],
      },
    ]
    const before = marshalUpdate(current)
    const draft = toPresetEditorDraft(current)
    draft.blocks[1]!.variables![1]!.id = draft.blocks[1]!.variables![0]!.id

    expect(() => applyPresetEditorDraft(current, draft)).toThrow()
    expect(marshalUpdate(current)).toEqual(before)
  })

  test('allows a valid change in one duplicate-block occurrence beside unchanged legacy data', () => {
    const current = createNewLoomPreset('Mixed valid legacy source')
    const base = current.blocks[0]!
    current.blocks = [
      {
        ...base,
        id: 'duplicate-block',
        variables: [
          { id: '', name: '', label: 'Legacy empty', type: 'text', defaultValue: '' },
          { id: 'legacy-id', name: 'legacy', label: 'Legacy duplicate', type: 'text', defaultValue: '' },
        ],
      },
      {
        ...base,
        id: 'duplicate-block',
        variables: [
          { id: 'modern-first', name: 'first', label: 'First', type: 'text', defaultValue: '' },
          { id: 'modern-second', name: 'second', label: 'Second', type: 'text', defaultValue: '' },
        ],
      },
    ]
    const draft = toPresetEditorDraft(current)
    draft.blocks[1]!.name = 'Changed modern occurrence'
    draft.blocks[1]!.content = 'Changed modern content'

    const next = applyPresetEditorDraft(current, draft)
    const persistedBlocks = marshalUpdate(next).prompt_order!

    expect(persistedBlocks.map((block) => block.id)).toEqual(['duplicate-block', 'duplicate-block'])
    expect(persistedBlocks[0]!.variables?.map((variable) => variable.id)).toEqual(['', 'legacy-id'])
    expect(persistedBlocks[1]!.name).toBe('Changed modern occurrence')
    expect(persistedBlocks[1]!.content).toBe('Changed modern content')
    expect(persistedBlocks[1]!.variables?.map((variable) => variable.id)).toEqual(['modern-first', 'modern-second'])
  })

  test('rejects radio overflow in the first duplicate category occurrence', () => {
    const current = createNewLoomPreset('Duplicate radio category source')
    const base = current.blocks[0]!
    current.blocks = [
      {
        ...base,
        id: 'cat',
        name: 'First category',
        marker: 'category',
        categoryMode: 'radio',
        group: null,
      },
      { ...base, id: 'child-1', name: 'First child', group: 'cat', categoryMode: null, enabled: true },
      { ...base, id: 'child-2', name: 'Second child', group: 'cat', categoryMode: null, enabled: false },
      {
        ...base,
        id: 'cat',
        name: 'Second category',
        marker: 'category',
        categoryMode: 'radio',
        group: null,
      },
    ]
    const before = marshalUpdate(current)
    const draft = toPresetEditorDraft(current)
    draft.blocks[2]!.enabled = true

    expect(() => applyPresetEditorDraft(current, draft)).toThrow(/radio category/)
    expect(marshalUpdate(current)).toEqual(before)
  })

  test('retains radio overflow rejection for unique category IDs', () => {
    const current = createNewLoomPreset('Unique radio category source')
    const base = current.blocks[0]!
    current.blocks = [
      {
        ...base,
        id: 'unique-cat',
        name: 'Category',
        marker: 'category',
        categoryMode: 'radio',
        group: null,
      },
      { ...base, id: 'unique-child-1', name: 'First child', group: 'unique-cat', categoryMode: null, enabled: true },
      { ...base, id: 'unique-child-2', name: 'Second child', group: 'unique-cat', categoryMode: null, enabled: false },
    ]
    const draft = toPresetEditorDraft(current)
    draft.blocks[2]!.enabled = true

    expect(() => applyPresetEditorDraft(current, draft)).toThrow(/radio category/)
  })

  test('accepts a prompt value compatible with any unchanged duplicate-name candidate', () => {
    const current = createNewLoomPreset('Duplicate variable name source')
    const block = current.blocks[0]!
    block.variables = [
      { id: 'number-candidate', name: 'tone', label: 'Number tone', type: 'number', defaultValue: 0 },
      { id: 'text-candidate', name: 'tone', label: 'Text tone', type: 'text', defaultValue: '' },
    ]
    current.promptVariables = {
      [block.id]: { tone: 'legacy text value' },
    }
    const draft = toPresetEditorDraft(current)
    draft.name = 'Duplicate variable name metadata update'

    const next = applyPresetEditorDraft(current, draft)
    const persisted = marshalUpdate(next)

    expect(next.promptVariables).toEqual({
      [block.id]: { tone: 'legacy text value' },
    })
    expect(persisted.metadata?.promptVariables).toEqual({
      [block.id]: { tone: 'legacy text value' },
    })
  })
  test('tolerates unchanged legacy duplicate IDs when unrelated blocks are added or removed', () => {
    const current = createNewLoomPreset('Legacy occurrence count source')
    const base = current.blocks[0]!
    current.blocks = [
      {
        ...base,
        id: 'legacy-duplicate',
        name: 'Legacy first',
        content: 'First legacy content',
        variables: [{ id: 'first-variable', name: 'first', label: 'First variable', type: 'text', defaultValue: 'first' }],
        sealed: true,
        sealedKey: 'first-sealed-key',
        sealedSource: 'lumihub',
        sealedOriginPresetId: 'first-origin',
        sealedOriginVersion: 'v1',
        sealedSha256: 'first-sha',
      },
      { ...base, id: 'unrelated', name: 'Unrelated block', content: 'Unrelated content' },
      {
        ...base,
        id: 'legacy-duplicate',
        name: 'Legacy second',
        content: 'Second legacy content',
        variables: [{ id: 'second-variable', name: 'second', label: 'Second variable', type: 'text', defaultValue: 'second' }],
        sealed: true,
        sealedKey: 'second-sealed-key',
        sealedSource: 'lumihub',
        sealedOriginPresetId: 'second-origin',
        sealedOriginVersion: 'v2',
        sealedSha256: 'second-sha',
      },
    ]
    const cases = [
      {
        label: 'unrelated block added',
        expectedIds: ['legacy-duplicate', 'added', 'unrelated', 'legacy-duplicate'],
        expectedPayload: [
          { id: 'legacy-duplicate', name: 'Legacy first', content: 'First legacy content' },
          { id: 'added', name: 'Added block', content: 'Unrelated content' },
          { id: 'unrelated', name: 'Unrelated block', content: 'Unrelated content' },
          { id: 'legacy-duplicate', name: 'Legacy second', content: 'Second legacy content' },
        ],
        mutate(draft: SpindlePresetEditorDraft) {
          draft.blocks.splice(1, 0, { ...draft.blocks[1]!, id: 'added', name: 'Added block' })
        },
      },
      {
        label: 'unrelated block removed',
        expectedIds: ['legacy-duplicate', 'legacy-duplicate'],
        expectedPayload: [
          { id: 'legacy-duplicate', name: 'Legacy first', content: 'First legacy content' },
          { id: 'legacy-duplicate', name: 'Legacy second', content: 'Second legacy content' },
        ],
        mutate(draft: SpindlePresetEditorDraft) {
          draft.blocks = [draft.blocks[0]!, draft.blocks[2]!]
        },
      },
    ]

    for (const { label, expectedIds, expectedPayload, mutate } of cases) {
      const draft = toPresetEditorDraft(current)
      mutate(draft)

      const next = applyPresetEditorDraft(current, draft)
      const persistedBlocks = marshalUpdate(next).prompt_order!

      expect(persistedBlocks.map((block) => block.id), label).toEqual(expectedIds)
      expect(persistedBlocks.map(({ id, name, content }) => ({ id, name, content })), label).toEqual(expectedPayload)
      expect(persistedBlocks.filter((block) => block.id === 'legacy-duplicate')).toHaveLength(2)
      const persistedLegacyBlocks = persistedBlocks.filter((block) => block.id === 'legacy-duplicate')
      expect(persistedLegacyBlocks.map((block) => ({
        sealed: Reflect.get(block, 'sealed'),
        sealedKey: Reflect.get(block, 'sealedKey'),
        sealedSource: Reflect.get(block, 'sealedSource'),
        sealedOriginPresetId: Reflect.get(block, 'sealedOriginPresetId'),
        sealedOriginVersion: Reflect.get(block, 'sealedOriginVersion'),
        sealedSha256: Reflect.get(block, 'sealedSha256'),
      })), label).toEqual([
        {
          sealed: true,
          sealedKey: 'first-sealed-key',
          sealedSource: 'lumihub',
          sealedOriginPresetId: 'first-origin',
          sealedOriginVersion: 'v1',
          sealedSha256: 'first-sha',
        },
        {
          sealed: true,
          sealedKey: 'second-sealed-key',
          sealedSource: 'lumihub',
          sealedOriginPresetId: 'second-origin',
          sealedOriginVersion: 'v2',
          sealedSha256: 'second-sha',
        },
      ])
      expect(persistedLegacyBlocks.map((block) => block.variables?.map((variable) => ({
        id: variable.id,
        name: variable.name,
        label: variable.label,
        defaultValue: variable.defaultValue,
      }))), label).toEqual([
        [{ id: 'first-variable', name: 'first', label: 'First variable', defaultValue: 'first' }],
        [{ id: 'second-variable', name: 'second', label: 'Second variable', defaultValue: 'second' }],
      ])
    }
  })

  test('prunes duplicate multiselect prompt values during an unrelated update', () => {
    const current = createNewLoomPreset('Duplicate multiselect value source')
    const block = current.blocks[0]!
    block.variables = [{
      id: 'choices-id',
      name: 'choices',
      label: 'Choices',
      type: 'multiselect',
      defaultValue: ['first'],
      options: [
        { id: 'first', label: 'First', value: 'first' },
        { id: 'second', label: 'Second', value: 'second' },
      ],
    }]
    current.promptVariables = {
      [block.id]: { choices: ['first', 'first'] },
    }
    const originalValues = structuredClone(current.promptVariables)
    const draft = toPresetEditorDraft(current)
    draft.name = 'Duplicate multiselect value pruned'

    const next = applyPresetEditorDraft(current, draft)
    const persisted = marshalUpdate(next)

    expect(next.name).toBe('Duplicate multiselect value pruned')
    expect(next.promptVariables?.[block.id]?.choices).toBeUndefined()
    expect(persisted.metadata?.promptVariables).toEqual({})
    expect(current.promptVariables).toEqual(originalValues)
  })

})
