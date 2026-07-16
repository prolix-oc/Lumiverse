import { describe, expect, test } from 'bun:test'
import {
  normalizeCategoryBlockState,
  pruneOrphanPromptVariables,
  reconcilePromptVariableValues,
  toggleBlockWithCategoryRules,
  validatePromptVariableSchema,
} from './service'
import type {
  PromptBlock,
  PromptVariableDef,
  PromptVariableValues,
} from './types'

function block(id: string, variables: PromptVariableDef[] = []): PromptBlock {
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
    variables,
  }
}

const text = (id: string, name: string): PromptVariableDef => ({
  id,
  name,
  label: name,
  type: 'text',
  defaultValue: '',
})

const select = (id: string, name: string, optionId: string): PromptVariableDef => ({
  id,
  name,
  label: name,
  type: 'select',
  defaultValue: optionId,
  options: [{ id: optionId, label: optionId, value: optionId }],
})

const slider = (id: string, name: string, max: number): PromptVariableDef => ({
  id,
  name,
  label: name,
  type: 'slider',
  defaultValue: 0,
  min: 0,
  max,
})
const multiselect = (id: string, name: string, optionIds: string[]): PromptVariableDef => ({
  id,
  name,
  label: name,
  type: 'multiselect',
  defaultValue: optionIds.length > 0 ? [optionIds[0]] : [],
  options: optionIds.map((optionId) => ({ id: optionId, label: optionId, value: optionId })),
})

describe('Loom prompt-variable schema and value reconciliation', () => {
  test('migrates compatible values by stable block and variable IDs when names change', () => {
    const previous = [block('chat', [text('tone-id', 'tone')])]
    const next = [block('chat', [text('tone-id', 'voice')])]

    expect(reconcilePromptVariableValues(
      { chat: { tone: 'concise' } },
      previous,
      next,
    )).toEqual({ chat: { voice: 'concise' } })
  })

  test('rejects duplicate final names, IDs, and block IDs before changing any values', () => {
    const previous = [block('chat', [text('tone-id', 'tone')])]
    const values: PromptVariableValues = { chat: { tone: 'preserve' } }
    const before = structuredClone(values)
    const duplicateName = [block('chat', [text('one', 'tone'), text('two', 'tone')])]
    const duplicateId = [block('chat', [text('same', 'tone'), text('same', 'voice')])]
    const duplicateBlockId = [block('chat'), block('chat')]

    expect(() => reconcilePromptVariableValues(values, previous, duplicateName)).toThrow()
    expect(values).toEqual(before)
    expect(() => reconcilePromptVariableValues(values, previous, duplicateId)).toThrow()
    expect(values).toEqual(before)
    expect(() => reconcilePromptVariableValues(values, previous, duplicateBlockId)).toThrow()
    expect(values).toEqual(before)
  })
  test('rejects duplicate names before inspecting the value map', () => {
    const duplicateName = [block('chat', [text('one', 'tone'), text('two', 'tone')])]
    const values = Object.create(null) as PromptVariableValues
    Object.defineProperty(values, 'chat', {
      enumerable: true,
      get() {
        throw new Error('value-map getter should not execute')
      },
    })

    expect(() => reconcilePromptVariableValues(values, null, duplicateName))
      .toThrow('duplicate variable name')
  })

  test('rejects empty final names and IDs instead of silently overwriting values', () => {
    const previous = [block('chat', [text('tone-id', 'tone')])]
    const values: PromptVariableValues = { chat: { tone: 'preserve' } }
    const before = structuredClone(values)
    const emptyVariableId = [block('chat', [text('', 'tone')])]
    const emptyVariableName = [block('chat', [text('tone-id', '')])]
    const emptyBlockId = [block('', [text('tone-id', 'tone')])]

    expect(() => reconcilePromptVariableValues(values, previous, emptyVariableId)).toThrow()
    expect(values).toEqual(before)
    expect(() => reconcilePromptVariableValues(values, previous, emptyVariableName)).toThrow()
    expect(values).toEqual(before)
    expect(() => reconcilePromptVariableValues(values, previous, emptyBlockId)).toThrow()
    expect(values).toEqual(before)
  })

  test('prunes removed, stale, incompatible, out-of-range, and invalid-choice values', () => {
    const previous = [block('chat', [
      text('changed-type', 'changedType'),
      select('choice-id', 'choice', 'legacy'),
      slider('range-id', 'range', 10),
      text('removed-id', 'removed'),
    ])]
    const next = [block('chat', [
      { ...text('changed-type', 'changedType'), type: 'switch', defaultValue: 0 },
      select('choice-id', 'choice', 'current'),
      slider('range-id', 'range', 5),
    ])]
    const values: PromptVariableValues = {
      chat: {
        changedType: 'no longer compatible',
        choice: 'legacy',
        range: 8,
        removed: 'gone',
        stableStale: 'stale',
      },
      deletedBlock: { anything: 'stale' },
    }

    expect(reconcilePromptVariableValues(values, previous, next)).toEqual({})
  })
  test('prunes legacy duplicate names using the first compatible definition without reading prototypes or getters', () => {
    let secondDefinitionRead = false
    const secondDefinition = text('second-definition', 'choice')
    Object.defineProperty(secondDefinition, 'label', {
      enumerable: true,
      configurable: true,
      get() {
        secondDefinitionRead = true
        return 'second definition'
      },
    })
    const legacyBlock = block('chat', [
      select('first-definition', 'choice', 'first'),
      secondDefinition,
    ])
    const blocks = [legacyBlock] as PromptBlock[]
    const blockPrototype = Object.create(Array.prototype)
    Object.defineProperty(blockPrototype, '1', {
      enumerable: true,
      get() {
        throw new Error('inherited schema getter should not execute')
      },
    })
    Object.setPrototypeOf(blocks, blockPrototype)

    const bucketPrototype = Object.create(null)
    Object.defineProperty(bucketPrototype, 'choice', {
      enumerable: true,
      get() {
        throw new Error('inherited value getter should not execute')
      },
    })
    const bucket = Object.create(bucketPrototype) as Record<string, unknown>
    Object.defineProperty(bucket, 'choice', {
      value: 'second',
      enumerable: true,
      configurable: true,
      writable: true,
    })
    Object.defineProperty(bucket, 'unexpected', {
      enumerable: true,
      get() {
        throw new Error('value getter should not execute')
      },
    })
    const valuesPrototype = Object.create(null)
    Object.defineProperty(valuesPrototype, 'inheritedOnly', {
      enumerable: true,
      get() {
        throw new Error('inherited bucket getter should not execute')
      },
    })
    const values = Object.create(valuesPrototype) as PromptVariableValues
    Object.defineProperty(values, 'chat', {
      value: bucket,
      enumerable: true,
      configurable: true,
      writable: true,
    })

    const pruned = pruneOrphanPromptVariables(values, blocks)

    expect(pruned.chat).toEqual({ choice: 'second' })
    expect(secondDefinitionRead).toBe(false)
    expect(Object.getPrototypeOf(pruned)).toBeNull()
    expect(Object.getPrototypeOf(pruned.chat!)).toBeNull()
    expect(Object.hasOwn(pruned.chat!, 'choice')).toBe(true)
    expect(Object.hasOwn(pruned.chat!, 'unexpected')).toBe(false)
    expect(Object.hasOwn(pruned, 'inheritedOnly')).toBe(false)
  })

  test('unions disjoint definitions across duplicate block IDs and clones nested values', () => {
    const blocks = [
      block('chat', [
        text('first-id', 'first'),
        multiselect('tags-id', 'tags', ['alpha', 'beta']),
      ]),
      block('chat', [slider('later-id', 'later', 10)]),
    ]
    const values: PromptVariableValues = {
      chat: {
        first: 'from first occurrence',
        later: 7,
        tags: ['alpha'],
      },
      orphan: { stale: 'remove this bucket' },
    }
    const sourceBefore = structuredClone(values)
    const expected = {
      chat: {
        first: 'from first occurrence',
        later: 7,
        tags: ['alpha'],
      },
    }

    const pruned = pruneOrphanPromptVariables(values, blocks)

    expect(pruned).toEqual(expected)
    expect(pruned).not.toBe(values)
    expect(pruned.chat).not.toBe(values.chat)
    const returnedTags = pruned.chat?.tags
    expect(Array.isArray(returnedTags)).toBe(true)
    if (!Array.isArray(returnedTags)) throw new Error('expected a multiselect array')
    expect(returnedTags).not.toBe(values.chat?.tags)
    returnedTags.push('beta')

    const fresh = pruneOrphanPromptVariables(values, blocks)
    expect(fresh).not.toBe(pruned)
    expect(fresh.chat).not.toBe(pruned.chat)
    const freshTags = fresh.chat?.tags
    expect(Array.isArray(freshTags)).toBe(true)
    if (!Array.isArray(freshTags)) throw new Error('expected a fresh multiselect array')
    expect(freshTags).not.toBe(returnedTags)
    expect(freshTags).toEqual(['alpha'])
    expect(pruned.chat?.tags).toEqual(['alpha', 'beta'])
    expect(values).toEqual(sourceBefore)
    expect(values.chat?.tags).toEqual(['alpha'])
  })

  test('accepts same-name values compatible with either duplicate definition and prunes all other values', () => {
    const blocks = [
      block('chat', [
        select('first-choice-id', 'choice', 'first-choice'),
        text('kept-id', 'kept'),
      ]),
      block('chat', [select('later-choice-id', 'choice', 'later-choice')]),
    ]

    expect(pruneOrphanPromptVariables(
      { chat: { choice: 'first-choice' } },
      blocks,
    )).toEqual({ chat: { choice: 'first-choice' } })
    expect(pruneOrphanPromptVariables(
      { chat: { choice: 'later-choice' } },
      blocks,
    )).toEqual({ chat: { choice: 'later-choice' } })
    expect(pruneOrphanPromptVariables(
      {
        chat: {
          choice: 'unsupported-choice',
          kept: 'preserve this value',
          unknown: 'remove this name',
        },
        orphan: { choice: 'later-choice' },
      },
      blocks,
    )).toEqual({ chat: { kept: 'preserve this value' } })
  })

  test('accepts same-name values across duplicate definitions with different types', () => {
    const blocks = [
      block('chat', [text('text-choice-id', 'choice')]),
      block('chat', [slider('slider-choice-id', 'choice', 10)]),
    ]

    expect(pruneOrphanPromptVariables(
      { chat: { choice: 'text-only value' } },
      blocks,
    )).toEqual({ chat: { choice: 'text-only value' } })
    expect(pruneOrphanPromptVariables(
      { chat: { choice: 7 } },
      blocks,
    )).toEqual({ chat: { choice: 7 } })
  })

  test('does not let malformed or variable-less duplicate occurrences erase valid definitions', () => {
    const validEarlier = block('chat', [text('first-id', 'first')])
    const validLater = block('chat', [text('later-id', 'later')])
    const noVariables: PromptBlock = { ...block('chat'), variables: undefined }
    const malformedVariables: PromptBlock = {
      ...block('chat'),
      variables: { not: 'an array' } as unknown as PromptVariableDef[],
    }
    const values: PromptVariableValues = {
      chat: {
        first: 'from earlier occurrence',
        later: 'from later occurrence',
      },
    }

    expect(pruneOrphanPromptVariables(
      values,
      [validEarlier, noVariables, malformedVariables, validLater],
    )).toEqual(values)
    expect(pruneOrphanPromptVariables(
      values,
      [validEarlier, validLater, noVariables, malformedVariables],
    )).toEqual(values)
  })

  test('preserves first-occurrence ordering across empty and malformed duplicates', () => {
    const earlyDuplicates: PromptBlock[] = [
      { ...block('A'), variables: undefined },
      { ...block('A'), variables: [] },
      { ...block('A'), variables: { not: 'an array' } as unknown as PromptVariableDef[] },
    ]
    const intervening = block('B', [text('b-id', 'b')])
    const laterValid = block('A', [text('a-id', 'a')])
    const values: PromptVariableValues = {
      A: { a: 'keep A' },
      B: { b: 'keep B' },
    }
    const expected = {
      A: { a: 'keep A' },
      B: { b: 'keep B' },
    }

    for (const earlyDuplicate of earlyDuplicates) {
      const pruned = pruneOrphanPromptVariables(values, [
        earlyDuplicate,
        intervening,
        laterValid,
      ])

      expect(Object.keys(pruned)).toEqual(['A', 'B'])
      expect(pruned).toEqual(expected)
    }
  })



  test('normalizes radio categories to one enabled child and switches the winner atomically', () => {
    const category = { ...block('category'), marker: 'category', categoryMode: 'radio' as const }
    const first = { ...block('first'), group: 'category' }
    const second = { ...block('second'), group: 'category' }

    const normalized = normalizeCategoryBlockState([category, first, second])
    expect(normalized.filter((entry) => entry.group === 'category' && entry.enabled).map((entry) => entry.id))
      .toEqual(['first'])

    const switched = toggleBlockWithCategoryRules(normalized, 'second')
    expect(switched.filter((entry) => entry.group === 'category' && entry.enabled).map((entry) => entry.id))
      .toEqual(['second'])
  })
})
