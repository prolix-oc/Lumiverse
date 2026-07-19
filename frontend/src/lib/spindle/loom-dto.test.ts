import { describe, expect, test } from 'bun:test'
import type {
  PromptBlockDTO,
  PromptVariableDefDTO,
  SpindleLoomBlockEditorValue,
} from 'lumiverse-spindle-types'
import {
  cloneLoomOptions,
  cloneLoomValue,
  LOOM_DTO_LIMITS,
  MACRO_CATALOG_LIMITS,
  normalizeMacroCatalog,
  patchLoomOptions,
  validateLoomValue,
} from './loom-dto'

function block(id: string, overrides: Partial<PromptBlockDTO> = {}): PromptBlockDTO {
  return {
    id,
    name: id,
    content: id,
    role: 'system',
    enabled: true,
    position: 'pre_history',
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    group: null,
    ...overrides,
  }
}

function value(overrides: Partial<SpindleLoomBlockEditorValue> = {}): SpindleLoomBlockEditorValue {
  return {
    blocks: [block('one')],
    promptVariableValues: {},
    ...overrides,
  }
}

function textVariable(overrides: Partial<Extract<PromptVariableDefDTO, { type: 'text' }>> = {}): PromptVariableDefDTO {
  return {
    id: 'tone',
    name: 'tone',
    label: 'Tone',
    type: 'text',
    defaultValue: '',
    ...overrides,
  }
}

function withVariable(variable: PromptVariableDefDTO = textVariable(), variableValue: unknown = 'warm'): SpindleLoomBlockEditorValue {
  const promptBlock = block('one', { variables: [variable] })
  return {
    blocks: [promptBlock],
    promptVariableValues: { one: { [variable.name]: variableValue as never } },
  }
}

describe('validateLoomValue', () => {
  test('accepts a valid minimal value', () => {
    expect(() => validateLoomValue(value())).not.toThrow()
  })

  test('rejects non-objects and wrong value keys', () => {
    expect(() => validateLoomValue(null)).toThrow()
    expect(() => validateLoomValue([])).toThrow()
    expect(() => validateLoomValue({ blocks: [], promptVariableValues: {}, extra: true })).toThrow('unknown field')
  })
  test('rejects sealed and provenance fields at the public DTO boundary', () => {
    const privateFields: Record<string, unknown> = {
      sealed: true,
      sealedKey: 'private-key',
      sealedSource: 'lumihub',
      sealedOriginPresetId: 'origin-preset',
      sealedOriginVersion: 'v3',
      sealedSha256: 'sha256:private',
    }
    for (const [key, fieldValue] of Object.entries(privateFields)) {
      expect(() => validateLoomValue(value({
        blocks: [block('private', { [key]: fieldValue } as never)],
      }))).toThrow('unknown field')
    }
  })


  test('rejects non-array, sparse, and duplicate blocks', () => {
    expect(() => validateLoomValue({ blocks: {}, promptVariableValues: {} })).toThrow()
    expect(() => validateLoomValue(value({ blocks: [block('same'), block('same')] }))).toThrow('duplicate id')
    const radioCategory = block('radio', { marker: 'category', categoryMode: 'radio' })
    const enabledChild = block('radio-one', { group: 'radio' })
    const secondEnabledChild = block('radio-two', { group: 'radio' })
    expect(() => validateLoomValue(value({ blocks: [radioCategory, enabledChild, secondEnabledChild] }))).toThrow('radio')

    const sparseBlocks: unknown[] = []
    sparseBlocks.length = 1
    expect(() => validateLoomValue(value({ blocks: sparseBlocks as PromptBlockDTO[] }))).toThrow('sparse array')
  })

  test('rejects invalid role, position, marker, and missing required fields', () => {
    expect(() => validateLoomValue(value({ blocks: [block('bad-role', { role: 'invalid' as never })] }))).toThrow('role')
    expect(() => validateLoomValue(value({ blocks: [block('bad-position', { position: 'invalid' as never })] }))).toThrow('position')
    expect(() => validateLoomValue(value({ blocks: [block('bad-marker', { marker: 42 as never })] }))).toThrow('marker')

    const missingName = block('missing-name') as unknown as Record<string, unknown>
    delete missingName.name
    expect(() => validateLoomValue(value({ blocks: [missingName as unknown as PromptBlockDTO] }))).toThrow('name')
  })

  test('rejects malformed variable definitions', () => {
    const malformed = textVariable({ type: 'unknown' as never })
    expect(() => validateLoomValue(withVariable(malformed))).toThrow('.type')

    const missingId = textVariable() as unknown as Record<string, unknown>
    delete missingId.id
    expect(() => validateLoomValue(withVariable(missingId as PromptVariableDefDTO))).toThrow('.id')

    const duplicateIds = [textVariable(), textVariable({ name: 'style' })]
    expect(() => validateLoomValue(value({ blocks: [block('one', { variables: duplicateIds })] }))).toThrow('duplicate id')

    const invalidRange = textVariable({ type: 'number' as never, defaultValue: 3 as never, min: 4 as never } as never)
    expect(() => validateLoomValue(withVariable(invalidRange, 3))).toThrow()

    const invalidOptions: PromptVariableDefDTO = {
      id: 'choice',
      name: 'choice',
      label: 'Choice',
      type: 'select',
      defaultValue: 'missing',
      options: [{ id: 'one', label: 'One', value: 'one' }],
    }
    expect(() => validateLoomValue(withVariable(invalidOptions, 'one'))).toThrow('defaultValue')
  })

  test('rejects mismatched prompt-variable values', () => {
    const variable = textVariable()
    expect(() => validateLoomValue(withVariable(variable, 1))).toThrow('promptVariableValues.one.tone')
    expect(() => validateLoomValue({ ...withVariable(variable), promptVariableValues: { other: { tone: 'warm' } } })).toThrow('block')
    expect(() => validateLoomValue({ ...withVariable(variable), promptVariableValues: { one: { missing: 'warm' } } })).toThrow('missing')

    const select: PromptVariableDefDTO = {
      id: 'choice',
      name: 'choice',
      label: 'Choice',
      type: 'select',
      defaultValue: 'one',
      options: [{ id: 'one', label: 'One', value: 'one' }],
    }
    expect(() => validateLoomValue(withVariable(select, 'two'))).toThrow('promptVariableValues.one.choice')
  })
  test('accepts values just below each collection and string limit', () => {
    const blocks = Array.from(
      { length: LOOM_DTO_LIMITS.maxBlocks - 1 },
      (_, index) => block(`block-${index}`),
    )
    expect(() => validateLoomValue(value({ blocks }))).not.toThrow()
    expect(() => validateLoomValue(value({
      blocks: Array.from(
        { length: LOOM_DTO_LIMITS.maxBlocks + 1 },
        (_, index) => block(`too-many-${index}`),
      ),
    }))).toThrow()

    const variables = Array.from(
      { length: LOOM_DTO_LIMITS.maxVariablesPerBlock - 1 },
      (_, index) => textVariable({ id: `var-${index}`, name: `var-${index}` }),
    )
    expect(() => validateLoomValue(value({ blocks: [block('vars', { variables })] }))).not.toThrow()
    expect(() => validateLoomValue(value({
      blocks: [block('vars', {
        variables: [
          ...variables,
          textVariable({ id: 'too-many-1', name: 'too-many-1' }),
          textVariable({ id: 'too-many-2', name: 'too-many-2' }),
        ],
      })],
    }))).toThrow()

    const options = Array.from(
      { length: LOOM_DTO_LIMITS.maxOptionsPerVariable - 1 },
      (_, index) => ({ id: `option-${index}`, label: `Option ${index}`, value: `${index}` }),
    )
    const select: PromptVariableDefDTO = {
      id: 'choice',
      name: 'choice',
      label: 'Choice',
      type: 'select',
      defaultValue: 'option-0',
      options,
    }
    expect(() => validateLoomValue(withVariable(select, 'option-0'))).not.toThrow()
    expect(() => validateLoomValue(withVariable({
      ...select,
      options: [
        ...options,
        { id: 'too-many-1', label: 'Too many 1', value: 'too-many-1' },
        { id: 'too-many-2', label: 'Too many 2', value: 'too-many-2' },
      ],
    }, 'option-0'))).toThrow()

    const promptBuckets = Object.create(null) as Record<string, Record<string, never>>
    const promptBlocks = Array.from(
      { length: LOOM_DTO_LIMITS.maxPromptBuckets },
      (_, index) => {
        const id = `bucket-${index}`
        Object.defineProperty(promptBuckets, id, {
          value: Object.create(null),
          enumerable: true,
          configurable: true,
          writable: true,
        })
        return block(id)
      },
    )
    Object.defineProperty(promptBuckets, 'overflow-bucket', {
      value: Object.create(null),
      enumerable: true,
      configurable: true,
      writable: true,
    })
    expect(() => validateLoomValue(value({
      blocks: promptBlocks,
      promptVariableValues: promptBuckets,
    }))).toThrow('Invalid Loom value.promptVariableValues: collection exceeds maxPromptBuckets limit')

    const promptValues = Array.from(
      { length: LOOM_DTO_LIMITS.maxPromptValuesPerBucket + 1 },
      (_, index) => textVariable({ id: `prompt-${index}`, name: `prompt-${index}` }),
    )
    const promptValueMap = Object.create(null) as Record<string, Record<string, string>>
    const promptBucket = Object.create(null) as Record<string, string>
    for (const variable of promptValues) {
      Object.defineProperty(promptBucket, variable.name, {
        value: 'value',
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    Object.defineProperty(promptValueMap, 'one', {
      value: promptBucket,
      enumerable: true,
      configurable: true,
      writable: true,
    })
    expect(() => validateLoomValue({
      blocks: [block('one', { variables: promptValues })],
      promptVariableValues: promptValueMap,
    })).toThrow('Invalid Loom value.promptVariableValues.one: collection exceeds maxPromptValuesPerBucket limit')


    const shortContent = 'x'.repeat(LOOM_DTO_LIMITS.maxStringLength - 1)
    expect(() => validateLoomValue(value({ blocks: [block('short', { content: shortContent })] }))).not.toThrow()
    expect(() => validateLoomValue(value({
      blocks: [block('long', { content: 'x'.repeat(LOOM_DTO_LIMITS.maxStringLength + 1) })],
    }))).toThrow('string length')
  })

  test('rejects cycles, accessors, deep graphs, and aggregate budgets before validation', () => {
    const cyclic = value() as unknown as Record<string, unknown>
    cyclic.cycle = cyclic
    expect(() => validateLoomValue(cyclic)).toThrow('cyclic')

    const accessor = value() as unknown as Record<string, unknown>
    Object.defineProperty(accessor, 'accessor', {
      get() {
        throw new Error('getter should not execute')
      },
      enumerable: true,
    })
    expect(() => validateLoomValue(accessor)).toThrow('data property')

    const deep = value() as unknown as Record<string, unknown>
    let cursor: Record<string, unknown> = deep
    for (let index = 0; index <= LOOM_DTO_LIMITS.maxDepth; index += 1) {
      const next: Record<string, unknown> = {}
      cursor.extra = next
      cursor = next
    }
    expect(() => validateLoomValue(deep)).toThrow('recursive depth')

    const manyEntries = value() as unknown as Record<string, unknown>
    const extraEntries: Record<string, unknown> = {}
    for (let index = 0; index <= LOOM_DTO_LIMITS.maxEntries; index += 1) {
      extraEntries[`entry-${index}`] = true
    }
    manyEntries.extra = extraEntries
    expect(() => validateLoomValue(manyEntries)).toThrow('entry budget')

    const manyNodes = value() as unknown as Record<string, unknown>
    manyNodes.extra = Array.from({ length: LOOM_DTO_LIMITS.maxNodes - 1 }, () => true)
    expect(() => validateLoomValue(manyNodes)).toThrow(/complexity|array length/)

    const belowAggregate = Array.from(
      { length: 700 },
      (_, index) => block(`aggregate-${index}`, { content: 'x'.repeat(8_000) }),
    )
    expect(() => validateLoomValue(value({ blocks: belowAggregate }))).not.toThrow()
    const aboveAggregate = Array.from(
      { length: 1_000 },
      (_, index) => block(`aggregate-${index}`, { content: 'x'.repeat(9_000) }),
    )
    expect(() => validateLoomValue(value({ blocks: aboveAggregate }))).toThrow('aggregate string')
  })
})

describe('cloneLoomValue', () => {
  test('deep-clones values and isolates object prototypes', () => {
    const source = withVariable()
    const clone = cloneLoomValue(source)

    expect(clone).not.toBe(source)
    expect(clone.blocks).not.toBe(source.blocks)
    expect(clone.blocks[0]).not.toBe(source.blocks[0])
    expect(Object.getPrototypeOf(clone)).toBeNull()
    expect(Object.getPrototypeOf(clone.blocks[0])).toBeNull()
    expect(Object.getPrototypeOf(clone.promptVariableValues)).toBeNull()
    expect(Object.getPrototypeOf(clone.blocks)).toBe(Array.prototype)
    expect(Object.getPrototypeOf(clone.blocks[0]?.variables)).toBe(Array.prototype)
    expect(Object.getPrototypeOf(clone.blocks[0]?.variables?.[0])).toBeNull()

    clone.blocks[0]!.name = 'changed'
    clone.blocks[0]!.variables![0]!.label = 'Changed'
    clone.promptVariableValues.one!.tone = 'cool'
    expect(source.blocks[0]!.name).toBe('one')
    expect(source.blocks[0]!.variables![0]!.label).toBe('Tone')
    expect(source.promptVariableValues.one!.tone).toBe('warm')
  })

  test('rejects poisoned prototypes and sparse arrays before cloning', () => {
    const poisonedValue = value()
    Object.setPrototypeOf(poisonedValue, { blocks: poisonedValue.blocks, promptVariableValues: {} })
    expect(() => cloneLoomValue(poisonedValue)).toThrow()

    const poisonedBlock = block('poisoned')
    Object.setPrototypeOf(poisonedBlock, { name: 'poisoned' })
    expect(() => cloneLoomValue(value({ blocks: [poisonedBlock] }))).toThrow()

    const sparseBlocks: PromptBlockDTO[] = []
    sparseBlocks.length = 1
    expect(() => cloneLoomValue(value({ blocks: sparseBlocks }))).toThrow('sparse array')
  })
  test('preserves prototype-sensitive prompt variable ids in isolated output maps', () => {
    const names = ['__proto__', 'constructor', 'toString']
    const variables = names.map((name) => textVariable({ id: name, name }))
    const promptVariableValues = Object.create(null) as Record<string, Record<string, string>>
    const bucket = Object.create(null) as Record<string, string>
    for (const name of names) {
      Object.defineProperty(bucket, name, {
        value: name,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    Object.defineProperty(promptVariableValues, 'one', {
      value: bucket,
      enumerable: true,
      configurable: true,
      writable: true,
    })
    const source = value({
      blocks: [block('one', { variables })],
      promptVariableValues,
    })
    const clone = cloneLoomValue(source)
    expect(Object.getPrototypeOf(clone.promptVariableValues)).toBeNull()
    expect(Object.getPrototypeOf(clone.promptVariableValues.one)).toBeNull()
    for (const name of names) {
      expect(Object.hasOwn(clone.promptVariableValues.one!, name)).toBe(true)
      expect(clone.promptVariableValues.one![name]).toBe(name)
    }
    expect(source.promptVariableValues.one).toBe(bucket)
  })

})

describe('Loom option cloning and patches', () => {
  test('clones options and defaults readOnly to false and compact to true', () => {
    const source = value()
    const onChange = () => {}
    const options = cloneLoomOptions({ value: source, onChange })

    expect(options.readOnly).toBe(false)
    expect(options.compact).toBe(true)
    expect(options.onChange).toBe(onChange)
    expect(options.value).not.toBe(source)
    expect(Object.getPrototypeOf(options.value)).toBeNull()
  })

  test('applies partial patches and preserves unchanged fields', () => {
    const onChange = () => {}
    const replacement = value({ blocks: [block('replacement')] })
    const current = cloneLoomOptions({ value: value(), onChange, compact: true })
    const next = patchLoomOptions(current, { value: replacement, readOnly: true })

    expect(next.readOnly).toBe(true)
    expect(next.compact).toBe(true)
    expect(next.onChange).toBe(onChange)
    expect(next.value).not.toBe(replacement)
    expect(next.value.blocks[0]!.id).toBe('replacement')
    expect(current.readOnly).toBe(false)
    expect(current.value.blocks[0]!.id).toBe('one')
  })

  test('rejects invalid patches without changing the current options', () => {
    const current = cloneLoomOptions({ value: value() })
    expect(() => patchLoomOptions(current, { readOnly: 'yes' })).toThrow('readOnly')
    expect(() => patchLoomOptions(current, { value: { blocks: [], extra: true, promptVariableValues: {} } })).toThrow('unknown field')
    expect(current.readOnly).toBe(false)
    expect(current.value.blocks[0]!.id).toBe('one')
  })
})

describe('normalizeMacroCatalog', () => {
  test('accepts valid catalogs and filters other extension owners', () => {
    const catalog = normalizeMacroCatalog({
      categories: [
        {
          category: 'Core',
          macros: [{ name: 'core', syntax: '{{core}}', description: 'Core macro', returns: 'string' }],
        },
        {
          category: 'extension:Weather',
          macros: [{ name: 'weather', syntax: '{{weather}}', description: 'Weather macro', category: 'ignored' }],
        },
        {
          category: 'extension:Other',
          macros: [{ name: 'other', syntax: '{{other}}', description: 'Other macro' }],
        },
      ],
    }, ' weather ')

    expect(catalog).toEqual([
      {
        category: 'Core',
        macros: [{ name: 'core', syntax: '{{core}}', description: 'Core macro', returns: 'string' }],
      },
      {
        category: 'extension:Weather',
        macros: [{ name: 'weather', syntax: '{{weather}}', description: 'Weather macro' }],
      },
    ])
  })

  test('rejects invalid catalog shapes instead of silently fixing them', () => {
    expect(() => normalizeMacroCatalog(null, 'weather')).toThrow()
    expect(() => normalizeMacroCatalog({ categories: {} }, 'weather')).toThrow()
    expect(() => normalizeMacroCatalog({ categories: [{ category: 'Core', macros: {} }] }, 'weather')).toThrow()
    expect(() => normalizeMacroCatalog({ categories: [{ category: 1, macros: [] }] }, 'weather')).toThrow()
    expect(() => normalizeMacroCatalog({ categories: [{ category: 'Core', macros: [{ name: 'bad' }] }] }, 'weather')).toThrow()
    expect(() => normalizeMacroCatalog({ categories: [{ category: 'Core', macros: [{ name: 'bad', syntax: '{{bad}}', description: '', args: [{ name: 'x', optional: 'yes' }] }] }] }, 'weather')).toThrow()
    expect(() => normalizeMacroCatalog({ categories: [{ category: 'Core', macros: [{ name: 'bad', syntax: '{{bad}}', description: '', category: 42 }] }] }, 'weather')).toThrow('macro category')
    expect(() => normalizeMacroCatalog({ categories: [{ category: 'Core', macros: [{ name: 'bad', syntax: '{{bad}}', description: '', extra: true }] }] }, 'weather')).toThrow('unknown field')
    expect(() => normalizeMacroCatalog({ categories: [] }, '   ')).toThrow('extension identifier')
  })

  test('accepts catalogs just below each collection and string limit', () => {
    const categories = Array.from(
      { length: MACRO_CATALOG_LIMITS.maxCategories - 1 },
      (_, index) => ({ category: `Category ${index}`, macros: [] }),
    )
    expect(() => normalizeMacroCatalog({ categories }, 'owner')).not.toThrow()
    expect(() => normalizeMacroCatalog({
      categories: [
        ...categories,
        { category: 'overflow-1', macros: [] },
        { category: 'overflow-2', macros: [] },
      ],
    }, 'owner')).toThrow()

    const macros = Array.from(
      { length: MACRO_CATALOG_LIMITS.maxMacrosPerCategory - 1 },
      (_, index) => ({
        name: `macro-${index}`,
        syntax: `{{macro-${index}}}`,
        description: `Macro ${index}`,
      }),
    )
    expect(() => normalizeMacroCatalog({
      categories: [{ category: 'Core', macros }],
    }, 'owner')).not.toThrow()
    expect(() => normalizeMacroCatalog({
      categories: [{
        category: 'Core',
        macros: [
          ...macros,
          { name: 'overflow-1', syntax: '{{overflow-1}}', description: 'Overflow 1' },
          { name: 'overflow-2', syntax: '{{overflow-2}}', description: 'Overflow 2' },
        ],
      }],
    }, 'owner')).toThrow()

    const args = Array.from(
      { length: MACRO_CATALOG_LIMITS.maxArgumentsPerMacro - 1 },
      (_, index) => ({ name: `arg-${index}`, optional: index % 2 === 0 }),
    )
    expect(() => normalizeMacroCatalog({
      categories: [{
        category: 'Core',
        macros: [{ name: 'args', syntax: '{{args}}', description: 'Args', args }],
      }],
    }, 'owner')).not.toThrow()
    expect(() => normalizeMacroCatalog({
      categories: [{
        category: 'Core',
        macros: [{
          name: 'args',
          syntax: '{{args}}',
          description: 'Args',
          args: [
            ...args,
            { name: 'overflow-1', optional: false },
            { name: 'overflow-2', optional: true },
          ],
        }],
      }],
    }, 'owner')).toThrow()

    const shortSyntax = 'x'.repeat(MACRO_CATALOG_LIMITS.maxStringLength - 1)
    expect(() => normalizeMacroCatalog({
      categories: [{ category: 'Core', macros: [{ name: 'short', syntax: shortSyntax, description: '' }] }],
    }, 'owner')).not.toThrow()
    expect(() => normalizeMacroCatalog({
      categories: [{
        category: 'Core',
        macros: [{ name: 'long', syntax: 'x'.repeat(MACRO_CATALOG_LIMITS.maxStringLength + 1), description: '' }],
      }],
    }, 'owner')).toThrow('string length')
  })

  test('rejects catalog cycles, accessors, deep graphs, and aggregate budgets before normalization', () => {
    const cyclic = { categories: [] as unknown[] }
    cyclic.categories.push(cyclic)
    expect(() => normalizeMacroCatalog(cyclic, 'owner')).toThrow('cyclic')

    const accessor = {}
    Object.defineProperty(accessor, 'categories', {
      get() {
        throw new Error('getter should not execute')
      },
      enumerable: true,
    })
    expect(() => normalizeMacroCatalog(accessor, 'owner')).toThrow('data property')

    const deep: Record<string, unknown> = { categories: [] }
    let cursor = deep
    for (let index = 0; index <= MACRO_CATALOG_LIMITS.maxDepth; index += 1) {
      const next: Record<string, unknown> = {}
      cursor.extra = next
      cursor = next
    }
    expect(() => normalizeMacroCatalog(deep, 'owner')).toThrow('recursive depth')

    const manyEntries: Record<string, unknown> = { categories: [] }
    const extraEntries: Record<string, unknown> = {}
    for (let index = 0; index <= MACRO_CATALOG_LIMITS.maxEntries; index += 1) {
      extraEntries[`entry-${index}`] = true
    }
    manyEntries.extra = extraEntries
    expect(() => normalizeMacroCatalog(manyEntries, 'owner')).toThrow('entry budget')

    const manyNodes: Record<string, unknown> = { categories: [] }
    manyNodes.extra = Array.from({ length: MACRO_CATALOG_LIMITS.maxNodes - 1 }, () => true)
    expect(() => normalizeMacroCatalog(manyNodes, 'owner')).toThrow(/complexity|array length/)

    const belowAggregate = Array.from(
      { length: 80 },
      (_, index) => ({ name: `aggregate-${index}`, syntax: 'x'.repeat(45_000), description: '' }),
    )
    expect(() => normalizeMacroCatalog({
      categories: [{ category: 'Core', macros: belowAggregate }],
    }, 'owner')).not.toThrow()
    const aboveAggregate = Array.from(
      { length: 100 },
      (_, index) => ({ name: `aggregate-${index}`, syntax: 'x'.repeat(50_000), description: '' }),
    )
    expect(() => normalizeMacroCatalog({
      categories: [{ category: 'Core', macros: aboveAggregate }],
    }, 'owner')).toThrow('aggregate string')
  })
})
