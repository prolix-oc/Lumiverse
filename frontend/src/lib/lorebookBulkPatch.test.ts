import { describe, expect, test } from 'bun:test'
import {
  BULK_UNCHANGED,
  EMPTY_BULK_FIELD_FORM,
  buildBulkFieldPatch,
  hasBulkFieldMutation,
  isBulkApplyEnabled,
  type BulkFieldForm,
} from './lorebookBulkPatch'

const form = (patch: Partial<BulkFieldForm>): BulkFieldForm => ({ ...EMPTY_BULK_FIELD_FORM, ...patch })

describe('buildBulkFieldPatch', () => {
  test('sends nothing while every control is left alone', () => {
    expect(buildBulkFieldPatch(EMPTY_BULK_FIELD_FORM)).toEqual({})
    expect(hasBulkFieldMutation(EMPTY_BULK_FIELD_FORM)).toBe(false)
  })

  test('maps State Enable to disabled:false and Disable to disabled:true', () => {
    expect(buildBulkFieldPatch(form({ enabled: 'enabled' }))).toEqual({ disabled: false })
    expect(buildBulkFieldPatch(form({ enabled: 'disabled' }))).toEqual({ disabled: true })
  })

  test('maps each Type to its exact constant/vectorized pair', () => {
    expect(buildBulkFieldPatch(form({ trigger: 'constant' }))).toEqual({ constant: true, vectorized: false })
    expect(buildBulkFieldPatch(form({ trigger: 'keyword' }))).toEqual({ constant: false, vectorized: false })
    expect(buildBulkFieldPatch(form({ trigger: 'vector' }))).toEqual({ constant: false, vectorized: true })
  })

  test('never emits the retired enabled/trigger aliases', () => {
    const patch = buildBulkFieldPatch(form({ enabled: 'disabled', trigger: 'vector' }))
    expect(Object.keys(patch).sort()).toEqual(['constant', 'disabled', 'vectorized'])
    expect(patch).not.toHaveProperty('enabled')
    expect(patch).not.toHaveProperty('trigger')
  })

  test('keeps sparse numeric fields explicit, including a deliberate zero', () => {
    expect(buildBulkFieldPatch(form({ priority: '0' }))).toEqual({ priority: 0 })
    expect(buildBulkFieldPatch(form({ depth: '0' }))).toEqual({ depth: 0 })
    expect(buildBulkFieldPatch(form({ position: '0' }))).toEqual({ position: 0 })
    expect(buildBulkFieldPatch(form({ priority: '12', position: '4' }))).toEqual({ priority: 12, position: 4 })
  })

  test('drops blank and non-numeric number boxes instead of writing zero', () => {
    expect(buildBulkFieldPatch(form({ priority: '' }))).toEqual({})
    expect(buildBulkFieldPatch(form({ priority: '   ' }))).toEqual({})
    expect(buildBulkFieldPatch(form({ depth: 'not-a-number' }))).toEqual({})
  })

  test('floors a negative depth at zero and truncates fractional input', () => {
    expect(buildBulkFieldPatch(form({ depth: '-5' }))).toEqual({ depth: 0 })
    expect(buildBulkFieldPatch(form({ depth: '7.9' }))).toEqual({ depth: 7 })
    expect(buildBulkFieldPatch(form({ priority: '3.2' }))).toEqual({ priority: 3 })
  })

  test('omits the sentinel wherever a select carries it', () => {
    expect(buildBulkFieldPatch(form({ position: BULK_UNCHANGED }))).toEqual({})
    expect(buildBulkFieldPatch(form({ trigger: BULK_UNCHANGED, enabled: BULK_UNCHANGED }))).toEqual({})
  })

  test('combines a mixed numeric/State/Type selection into one exact patch', () => {
    expect(buildBulkFieldPatch(form({
      priority: '25',
      position: '1',
      depth: '-3',
      trigger: 'vector',
      enabled: 'enabled',
    }))).toEqual({
      priority: 25,
      position: 1,
      depth: 0,
      constant: false,
      vectorized: true,
      disabled: false,
    })
  })

  test('hasBulkFieldMutation follows the patch rather than the form', () => {
    expect(hasBulkFieldMutation(form({ enabled: 'enabled' }))).toBe(true)
    expect(hasBulkFieldMutation(form({ trigger: 'keyword' }))).toBe(true)
    expect(hasBulkFieldMutation(form({ priority: '0' }))).toBe(true)
    expect(hasBulkFieldMutation(form({ priority: 'garbage' }))).toBe(false)
    expect(hasBulkFieldMutation(form({ depth: BULK_UNCHANGED }))).toBe(false)
  })
})

describe('isBulkApplyEnabled', () => {
  const open = { bookId: 'book-1', selectedCount: 1, hasMutation: true, noticesReconciliation: false, pending: false }

  test('requires a book, a selection and a non-empty patch', () => {
    expect(isBulkApplyEnabled(open)).toBe(true)
    expect(isBulkApplyEnabled({ ...open, bookId: null })).toBe(false)
    expect(isBulkApplyEnabled({ ...open, selectedCount: 0 })).toBe(false)
    expect(isBulkApplyEnabled({ ...open, hasMutation: false })).toBe(false)
  })

  test('stays shut while a request is in flight or a reload is owed', () => {
    expect(isBulkApplyEnabled({ ...open, pending: true })).toBe(false)
    expect(isBulkApplyEnabled({ ...open, noticesReconciliation: true })).toBe(false)
  })
})
