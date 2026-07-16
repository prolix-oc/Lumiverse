import type {
  PromptBlockDTO,
  PromptVariableDefDTO,
  PromptVariableValuesDTO,
  SpindleLoomBlockEditorValue,
} from 'lumiverse-spindle-types'
import type { MacroGroup } from '@/lib/loom/types'

export interface NormalizedLoomOptions {
  value: SpindleLoomBlockEditorValue
  onChange?: (value: SpindleLoomBlockEditorValue) => void
  readOnly: boolean
  compact: boolean
}

export interface LoomValueValidationOptions {
  /** Legacy duplicate block IDs already present in the current graph. */
  readonly legacyDuplicateBlockIds?: ReadonlySet<string>
  /** Exact block occurrences whose legacy variable identity graph is unchanged. */
  readonly legacyDuplicateVariableBlockIndexes?: ReadonlySet<number>
}

type LoomGraphClone = {
  blocks: unknown
  promptVariableValues: unknown
}

type UnknownRecord = Record<string, unknown>

const LOOM_BLOCK_KEYS: Record<string, true> = {
  id: true,
  name: true,
  content: true,
  role: true,
  enabled: true,
  position: true,
  depth: true,
  marker: true,
  isLocked: true,
  color: true,
  injectionTrigger: true,
  characterTagTrigger: true,
  group: true,
  categoryMode: true,
  variables: true,
}

const REQUIRED_LOOM_BLOCK_KEYS: Record<string, true> = {
  id: true,
  name: true,
  content: true,
  role: true,
  enabled: true,
  position: true,
  depth: true,
  marker: true,
  isLocked: true,
  color: true,
  injectionTrigger: true,
  group: true,
}

const LOOM_VALUE_KEYS: Record<string, true> = {
  blocks: true,
  promptVariableValues: true,
}

const LOOM_OPTION_KEYS: Record<string, true> = {
  value: true,
  onChange: true,
  readOnly: true,
  compact: true,
}

const VARIABLE_BASE_KEYS: Record<string, true> = {
  id: true,
  name: true,
  label: true,
  type: true,
  defaultValue: true,
}

const VARIABLE_OPTION_KEYS: Record<string, true> = {
  id: true,
  label: true,
  value: true,
}
const MACRO_CATALOG_KEYS: Record<string, true> = {
  categories: true,
}

const MACRO_CATEGORY_KEYS: Record<string, true> = {
  category: true,
  macros: true,
}

const MACRO_ENTRY_KEYS: Record<string, true> = {
  name: true,
  syntax: true,
  description: true,
  args: true,
  returns: true,
  category: true,
}

const MACRO_ARGUMENT_KEYS: Record<string, true> = {
  name: true,
  optional: true,
}
export const LOOM_DTO_LIMITS = Object.freeze({
  maxDepth: 16,
  maxNodes: 16_384,
  maxEntries: 65_536,
  maxStringLength: 64 * 1024,
  maxStringBytes: 4 * 1024 * 1024,
  maxBlocks: 512,
  maxVariablesPerBlock: 512,
  maxOptionsPerVariable: 256,
  maxPromptBuckets: 512,
  maxPromptValuesPerBucket: 256,
})

export const MACRO_CATALOG_LIMITS = Object.freeze({
  maxDepth: 16,
  maxNodes: 8_192,
  maxEntries: 32_768,
  maxStringLength: 64 * 1024,
  maxStringBytes: 4 * 1024 * 1024,
  maxCategories: 128,
  maxMacrosPerCategory: 256,
  maxArgumentsPerMacro: 32,
})

type PreflightKind =
  | 'root'
  | 'blocks'
  | 'block'
  | 'variables'
  | 'variable'
  | 'options'
  | 'option'
  | 'promptBuckets'
  | 'promptBucket'
  | 'promptValues'
  | 'promptValue'
  | 'macroRoot'
  | 'macroCategories'
  | 'macroCategory'
  | 'macroMacros'
  | 'macroEntry'
  | 'macroArgs'
  | 'macroArg'
  | 'generic'

interface PreflightBudget {
  label: string
  limits: Readonly<Record<string, number>>
  nodes: number
  entries: number
  stringBytes: number
  ancestors: WeakSet<object>
}

const UTF8_ENCODER = new TextEncoder()

function preflightError(budget: PreflightBudget, label: string, message: string): never {
  throw new Error(`Invalid Loom ${label}: ${message}`)
}

function consumeNode(budget: PreflightBudget, label: string): void {
  budget.nodes += 1
  if (budget.nodes > budget.limits.maxNodes) {
    preflightError(budget, label, 'complexity budget exceeded')
  }
}

function consumeEntry(budget: PreflightBudget, label: string): void {
  budget.entries += 1
  if (budget.entries > budget.limits.maxEntries) {
    preflightError(budget, label, 'entry budget exceeded')
  }
}

function checkStringBudget(value: string, budget: PreflightBudget, label: string): void {
  if (value.length > budget.limits.maxStringLength) {
    preflightError(budget, label, 'string length exceeds limit')
  }
  budget.stringBytes += UTF8_ENCODER.encode(value).byteLength
  if (budget.stringBytes > budget.limits.maxStringBytes) {
    preflightError(budget, label, 'aggregate string byte budget exceeded')
  }
}

function assertCollectionBudget(
  length: number,
  budget: PreflightBudget,
  label: string,
  limitKey: string,
): void {
  const limit = budget.limits[limitKey]
  if (limit !== undefined && length > limit) {
    preflightError(budget, label, `collection exceeds ${limitKey} limit`)
  }
}

function getArrayElementKind(kind: PreflightKind): PreflightKind {
  if (kind === 'blocks') return 'block'
  if (kind === 'variables') return 'variable'
  if (kind === 'options') return 'option'
  if (kind === 'macroCategories') return 'macroCategory'
  if (kind === 'macroMacros') return 'macroEntry'
  if (kind === 'macroArgs') return 'macroArg'
  return 'generic'
}

function getPropertyKind(kind: PreflightKind, key: string): PreflightKind {
  if (kind === 'root') {
    if (key === 'blocks') return 'blocks'
    if (key === 'promptVariableValues') return 'promptBuckets'
  } else if (kind === 'block' && key === 'variables') {
    return 'variables'
  } else if (kind === 'variable' && key === 'options') {
    return 'options'
  } else if (kind === 'promptBuckets') {
    return 'promptBucket'
  } else if (kind === 'promptBucket') {
    return 'promptValue'
  } else if (kind === 'macroRoot' && key === 'categories') {
    return 'macroCategories'
  } else if (kind === 'macroCategory' && key === 'macros') {
    return 'macroMacros'
  } else if (kind === 'macroEntry' && key === 'args') {
    return 'macroArgs'
  }
  return 'generic'
}

function checkCollectionKind(kind: PreflightKind, length: number, budget: PreflightBudget, label: string): void {
  if (kind === 'blocks') {
    assertCollectionBudget(length, budget, label, 'maxBlocks')
  } else if (kind === 'variables') {
    assertCollectionBudget(length, budget, label, 'maxVariablesPerBlock')
  } else if (kind === 'options') {
    assertCollectionBudget(length, budget, label, 'maxOptionsPerVariable')
  } else if (kind === 'promptBuckets') {
    assertCollectionBudget(length, budget, label, 'maxPromptBuckets')
  } else if (kind === 'promptBucket') {
    assertCollectionBudget(length, budget, label, 'maxPromptValuesPerBucket')
  } else if (kind === 'macroCategories') {
    assertCollectionBudget(length, budget, label, 'maxCategories')
  } else if (kind === 'macroMacros') {
    assertCollectionBudget(length, budget, label, 'maxMacrosPerCategory')
  } else if (kind === 'macroArgs') {
    assertCollectionBudget(length, budget, label, 'maxArgumentsPerMacro')
  }
}

function preflightArray(
  value: unknown[],
  kind: PreflightKind,
  budget: PreflightBudget,
  label: string,
  depth: number,
): void {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Array.prototype) {
    preflightError(budget, label, 'prototype is not allowed')
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (!lengthDescriptor || !('value' in lengthDescriptor) || lengthDescriptor.enumerable) {
    preflightError(budget, label, 'length must be an array data property')
  }
  const length = lengthDescriptor.value
  if (!Number.isSafeInteger(length) || length < 0 || length > budget.limits.maxNodes) {
    preflightError(budget, label, 'array length exceeds limit')
  }
  checkCollectionKind(kind, length, budget, label)

  const symbols = Object.getOwnPropertySymbols(value)
  if (symbols.length > 0) {
    preflightError(budget, label, 'symbol fields are not allowed')
  }
  const keys = Object.getOwnPropertyNames(value)
  if (keys.length > budget.limits.maxEntries) {
    preflightError(budget, label, 'entry budget exceeded')
  }
  const descriptors = new Map<string, PropertyDescriptor>()
  for (const key of keys) {
    if (key === 'length') continue
    if (!/^(0|[1-9]\d*)$/.test(key)) {
      preflightError(budget, label, `unknown field "${key}"`)
    }
    const index = Number(key)
    if (index >= 0xffffffff || index >= length) {
      preflightError(budget, label, `unknown field "${key}"`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      preflightError(budget, label, `field "${key}" must be an enumerable data property`)
    }
    descriptors.set(key, descriptor)
  }
  for (let index = 0; index < length; index += 1) {
    if (!descriptors.has(String(index))) {
      preflightError(budget, label, 'sparse array')
    }
  }
  const elementKind = getArrayElementKind(kind)
  for (let index = 0; index < length; index += 1) {
    const key = String(index)
    consumeEntry(budget, `${label}[${index}]`)
    preflightNode(descriptors.get(key)!.value, elementKind, budget, `${label}[${index}]`, depth + 1)
  }
}

function preflightObject(
  value: Record<string, unknown>,
  kind: PreflightKind,
  budget: PreflightBudget,
  label: string,
  depth: number,
): void {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    preflightError(budget, label, 'prototype is not allowed')
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    preflightError(budget, label, 'symbol fields are not allowed')
  }
  const keys = Object.getOwnPropertyNames(value)
  if (keys.length > budget.limits.maxEntries) {
    preflightError(budget, label, 'entry budget exceeded')
  }
  checkCollectionKind(kind, keys.length, budget, label)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      preflightError(budget, label, `field "${key}" must be an enumerable data property`)
    }
    consumeEntry(budget, `${label}.${key}`)
    checkStringBudget(key, budget, `${label}.${key}`)
    preflightNode(descriptor.value, getPropertyKind(kind, key), budget, `${label}.${key}`, depth + 1)
  }
}

function preflightNode(
  value: unknown,
  kind: PreflightKind,
  budget: PreflightBudget,
  label: string,
  depth: number,
): void {
  consumeNode(budget, label)
  if (depth > budget.limits.maxDepth) {
    preflightError(budget, label, 'recursive depth exceeds limit')
  }
  if (typeof value === 'string') {
    checkStringBudget(value, budget, label)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (budget.ancestors.has(value)) {
    preflightError(budget, label, 'cyclic value is not allowed')
  }
  budget.ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      preflightArray(value, kind, budget, label, depth)
    } else {
      preflightObject(value as Record<string, unknown>, kind, budget, label, depth)
    }
  } finally {
    budget.ancestors.delete(value)
  }
}

function preflightLoomValue(value: unknown): void {
  preflightNode(value, 'root', {
    label: 'value',
    limits: LOOM_DTO_LIMITS,
    nodes: 0,
    entries: 0,
    stringBytes: 0,
    ancestors: new WeakSet<object>(),
  }, 'value', 0)
}

function preflightMacroCatalog(value: unknown): void {
  preflightNode(value, 'macroRoot', {
    label: 'macro catalog',
    limits: MACRO_CATALOG_LIMITS,
    nodes: 0,
    entries: 0,
    stringBytes: 0,
    ancestors: new WeakSet<object>(),
  }, 'macro catalog', 0)
}

function asRecord(value: unknown, label: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Loom ${label}`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`Invalid Loom ${label}`)
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`Invalid Loom ${label}`)
  }
  return value as UnknownRecord
}

function assertEnumerableDataProperties(value: UnknownRecord, label: string): void {
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`Invalid Loom ${label}: field "${key}" must be an enumerable data property`)
    }
  }
}

function assertExactKeys(value: UnknownRecord, allowed: Record<string, true>, label: string): void {
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!Object.prototype.hasOwnProperty.call(allowed, key)) {
      throw new Error(`Invalid Loom ${label}: unknown field "${key}"`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`Invalid Loom ${label}: field "${key}" must be an enumerable data property`)
    }
  }

  let prototype = Object.getPrototypeOf(value)
  while (prototype !== null) {
    for (const key of Object.getOwnPropertyNames(prototype)) {
      if (Object.prototype.hasOwnProperty.call(allowed, key) && !Object.prototype.hasOwnProperty.call(value, key)) {
        throw new Error(`Invalid Loom ${label}: field "${key}" must be an own property`)
      }
    }
    prototype = Object.getPrototypeOf(prototype)
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`Invalid Loom ${label}: unknown symbol field`)
  }
}

function assertArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`Invalid Loom ${label}`)
  }

  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === 'length') continue
    if (!/^(0|[1-9]\d*)$/.test(key)) {
      throw new Error(`Invalid Loom ${label}: unknown field "${key}"`)
    }
    const index = Number(key)
    if (index >= 0xffffffff || index >= value.length) {
      throw new Error(`Invalid Loom ${label}: unknown field "${key}"`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`Invalid Loom ${label}: field "${key}" must be an enumerable data property`)
    }
  }

  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, String(index))) {
      throw new Error(`Invalid Loom ${label}: sparse array`)
    }
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`Invalid Loom ${label}: unknown symbol field`)
  }
  return value
}

function assertString(value: unknown, label: string, nonEmpty = false): string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) {
    throw new Error(`Invalid Loom ${label}`)
  }
  return value
}

function assertFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid Loom ${label}`)
  }
  return value
}

function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid Loom ${label}`)
  return value
}

function assertOptionalString(value: unknown, label: string): void {
  if (value !== undefined) assertString(value, label)
}

function assertStringArray(value: unknown, label: string): string[] {
  const entries = assertArray(value, label)
  const seen = new Set<string>()
  for (const item of entries) {
    const string = assertString(item, label, true)
    if (seen.has(string)) throw new Error(`Invalid Loom ${label}: duplicate value`)
    seen.add(string)
  }
  return entries as string[]
}

function validateVariableOption(value: unknown, label: string): void {
  const option = asRecord(value, label)
  assertExactKeys(option, VARIABLE_OPTION_KEYS, label)
  assertString(option.id, `${label}.id`, true)
  assertString(option.label, `${label}.label`)
  assertString(option.value, `${label}.value`)
}

function validateVariableDefinition(
  value: unknown,
  label: string,
  allowLegacyIdentity: boolean,
): PromptVariableDefDTO {
  const variable = asRecord(value, label)
  assertEnumerableDataProperties(variable, label)
  if (!Object.prototype.hasOwnProperty.call(variable, 'type')) {
    throw new Error(`Invalid Loom ${label}.type`)
  }

  const type = assertString(variable.type, `${label}.type`, true)
  const allowed: Record<string, true> = { ...VARIABLE_BASE_KEYS }
  if (type === 'textarea') {
    allowed.rows = true
    allowed.description = true
  } else if (type === 'text' || type === 'number' || type === 'switch') {
    allowed.description = true
    if (type === 'number') {
      allowed.min = true
      allowed.max = true
      allowed.step = true
    }
  } else if (type === 'slider') {
    allowed.min = true
    allowed.max = true
    allowed.step = true
    allowed.description = true
  } else if (type === 'select') {
    allowed.options = true
    allowed.description = true
  } else if (type === 'multiselect') {
    allowed.options = true
    allowed.separator = true
    allowed.description = true
  } else {
    throw new Error(`Invalid Loom ${label}.type`)
  }

  assertExactKeys(variable, allowed, label)
  assertString(variable.id, `${label}.id`, !allowLegacyIdentity)
  assertString(variable.name, `${label}.name`, !allowLegacyIdentity)
  assertString(variable.label, `${label}.label`)
  assertOptionalString(variable.description, `${label}.description`)

  if (type === 'text' || type === 'textarea') {
    assertString(variable.defaultValue, `${label}.defaultValue`)
    if (type === 'textarea' && variable.rows !== undefined) {
      const rows = assertFiniteNumber(variable.rows, `${label}.rows`)
      if (!Number.isInteger(rows) || rows < 1) throw new Error(`Invalid Loom ${label}.rows`)
    }
  } else if (type === 'number' || type === 'slider') {
    const defaultValue = assertFiniteNumber(variable.defaultValue, `${label}.defaultValue`)
    const min = variable.min === undefined ? undefined : assertFiniteNumber(variable.min, `${label}.min`)
    const max = variable.max === undefined ? undefined : assertFiniteNumber(variable.max, `${label}.max`)
    if (min !== undefined && max !== undefined && min > max) throw new Error(`Invalid Loom ${label} range`)
    if (type === 'slider' && (min === undefined || max === undefined)) throw new Error(`Invalid Loom ${label} range`)
    if ((min !== undefined && defaultValue < min) || (max !== undefined && defaultValue > max)) {
      throw new Error(`Invalid Loom ${label}.defaultValue`)
    }
    if (variable.step !== undefined) {
      const step = assertFiniteNumber(variable.step, `${label}.step`)
      if (step <= 0) throw new Error(`Invalid Loom ${label}.step`)
    }
  } else if (type === 'switch') {
    const defaultValue = variable.defaultValue
    if (defaultValue !== 0 && defaultValue !== 1) throw new Error(`Invalid Loom ${label}.defaultValue`)
  } else {
    const optionEntries = assertArray(variable.options, `${label}.options`)
    if (optionEntries.length === 0) {
      throw new Error(`Invalid Loom ${label}.options`)
    }
    const optionIds = new Set<string>()
    optionEntries.forEach((option, index) => {
      validateVariableOption(option, `${label}.options[${index}]`)
      const optionRecord = option as UnknownRecord
      const optionId = optionRecord.id as string
      if (optionIds.has(optionId)) {
        throw new Error(`Invalid Loom ${label}.options: duplicate option`)
      }
      optionIds.add(optionId)
    })

    if (type === 'select') {
      const defaultValue = assertString(variable.defaultValue, `${label}.defaultValue`)
      if (!optionIds.has(defaultValue)) throw new Error(`Invalid Loom ${label}.defaultValue`)
    } else {
      const defaults = assertStringArray(variable.defaultValue, `${label}.defaultValue`)
      if (defaults.some((item) => !optionIds.has(item))) throw new Error(`Invalid Loom ${label}.defaultValue`)
      assertOptionalString(variable.separator, `${label}.separator`)
    }
  }

  return variable as PromptVariableDefDTO
}

function validatePromptVariableValue(value: unknown, variable: PromptVariableDefDTO, label: string): void {
  if (variable.type === 'text' || variable.type === 'textarea' || variable.type === 'select') {
    assertString(value, label)
    if (variable.type === 'select') {
      const options = (variable as Extract<PromptVariableDefDTO, { type: 'select' }>).options
      if (!options.some((option) => option.id === value)) throw new Error(`Invalid Loom ${label}`)
    }
  } else if (variable.type === 'number' || variable.type === 'slider') {
    const numericValue = assertFiniteNumber(value, label)
    if (variable.min !== undefined && numericValue < variable.min) throw new Error(`Invalid Loom ${label}`)
    if (variable.max !== undefined && numericValue > variable.max) throw new Error(`Invalid Loom ${label}`)
  } else if (variable.type === 'switch') {
    if (value !== 0 && value !== 1) throw new Error(`Invalid Loom ${label}`)
  } else {
    const values = assertStringArray(value, label)
    const options = (variable as Extract<PromptVariableDefDTO, { type: 'multiselect' }>).options
    if (values.some((item) => !options.some((option) => option.id === item))) {
      throw new Error(`Invalid Loom ${label}`)
    }
  }
}

export function validateLoomValue(
  value: unknown,
  options?: LoomValueValidationOptions,
): asserts value is SpindleLoomBlockEditorValue {
  preflightLoomValue(value)
  const record = asRecord(value, 'value')
  assertExactKeys(record, LOOM_VALUE_KEYS, 'value')
  if (!Object.prototype.hasOwnProperty.call(record, 'blocks')) throw new Error('Invalid Loom value.blocks')
  if (!Object.prototype.hasOwnProperty.call(record, 'promptVariableValues')) {
    throw new Error('Invalid Loom value.promptVariableValues')
  }

  const blocks = assertArray(record.blocks, 'value.blocks')
  const blocksById = new Map<string, PromptBlockDTO>()
  const variablesByBlock = new Map<string, Map<string, PromptVariableDefDTO[]>>()
  let activeCategoryId: string | null = null
  let activeCategoryMode: 'radio' | null = null
  let activeRadioEnabled = 0
  const finishRadioCategory = (): void => {
    if (activeCategoryMode === 'radio' && activeRadioEnabled > 1) {
      throw new Error(`Invalid Loom radio category "${activeCategoryId}"`)
    }
  }
  const legacyVariableIndexes = options?.legacyDuplicateVariableBlockIndexes
  const legacyBlockIds = options?.legacyDuplicateBlockIds

  blocks.forEach((rawBlock, index) => {
    const block = asRecord(rawBlock, `blocks[${index}]`)
    assertExactKeys(block, LOOM_BLOCK_KEYS, `blocks[${index}]`)
    for (const required of Object.keys(REQUIRED_LOOM_BLOCK_KEYS)) {
      if (!Object.prototype.hasOwnProperty.call(block, required)) {
        throw new Error(`Invalid Loom blocks[${index}].${required}`)
      }
    }

    const id = assertString(block.id, `blocks[${index}].id`, true)
    if (blocksById.has(id) && !legacyBlockIds?.has(id)) {
      throw new Error(`Invalid Loom blocks: duplicate id "${id}"`)
    }
    const marker = block.marker === null ? null : assertString(block.marker, `blocks[${index}].marker`)
    const role = assertString(block.role, `blocks[${index}].role`)
    if (!['system', 'user', 'assistant', 'user_append', 'assistant_append'].includes(role)) {
      throw new Error(`Invalid Loom blocks[${index}].role`)
    }
    const position = assertString(block.position, `blocks[${index}].position`)
    if (!['pre_history', 'post_history', 'in_history'].includes(position)) {
      throw new Error(`Invalid Loom blocks[${index}].position`)
    }
    assertString(block.name, `blocks[${index}].name`)
    assertString(block.content, `blocks[${index}].content`)
    assertBoolean(block.enabled, `blocks[${index}].enabled`)
    const depth = assertFiniteNumber(block.depth, `blocks[${index}].depth`)
    if (!Number.isInteger(depth) || depth < 0) throw new Error(`Invalid Loom blocks[${index}].depth`)
    assertBoolean(block.isLocked, `blocks[${index}].isLocked`)
    if (block.color !== null) assertString(block.color, `blocks[${index}].color`)
    assertStringArray(block.injectionTrigger, `blocks[${index}].injectionTrigger`)
    if (block.characterTagTrigger !== undefined) {
      assertStringArray(block.characterTagTrigger, `blocks[${index}].characterTagTrigger`)
    }
    if (block.group !== null) assertString(block.group, `blocks[${index}].group`, true)

    const categoryMode = block.categoryMode
    if (categoryMode !== undefined && categoryMode !== null && categoryMode !== 'radio' && categoryMode !== 'checkbox') {
      throw new Error(`Invalid Loom blocks[${index}].categoryMode`)
    }
    if (marker === 'category') {
      if (block.group !== null) throw new Error(`Invalid Loom blocks[${index}].group`)
      finishRadioCategory()
      activeCategoryId = id
      activeCategoryMode = categoryMode === 'radio' ? 'radio' : null
      activeRadioEnabled = 0
    } else {
      if (categoryMode !== undefined && categoryMode !== null) {
        throw new Error(`Invalid Loom blocks[${index}].categoryMode`)
      }
      if (block.group !== null && block.group !== undefined) {
        if (!activeCategoryId || activeCategoryId !== block.group) throw new Error(`Invalid Loom blocks[${index}].group`)
        if (activeCategoryMode === 'radio' && block.enabled) activeRadioEnabled += 1
      } else {
        finishRadioCategory()
        activeCategoryId = null
        activeCategoryMode = null
        activeRadioEnabled = 0
      }
    }

    const allowLegacyIdentity = legacyVariableIndexes?.has(index) === true
    if (Array.isArray(block.variables)) {
      const variableEntries = assertArray(block.variables, `blocks[${index}].variables`)
      let byName = variablesByBlock.get(id)
      if (!byName) {
        byName = new Map<string, PromptVariableDefDTO[]>()
        variablesByBlock.set(id, byName)
      }
      const byId = new Set<string>()
      const namesInBlock = new Set<string>()
      variableEntries.forEach((variable, variableIndex) => {
        const validated = validateVariableDefinition(
          variable,
          `blocks[${index}].variables[${variableIndex}]`,
          allowLegacyIdentity,
        )
        if (byId.has(validated.id) && !allowLegacyIdentity) {
          throw new Error(`Invalid Loom blocks[${index}].variables: duplicate id`)
        }
        if (namesInBlock.has(validated.name) && !allowLegacyIdentity) {
          throw new Error(`Invalid Loom blocks[${index}].variables: duplicate name`)
        }
        const candidates = byName.get(validated.name) ?? []
        byName.set(validated.name, [...candidates, validated])
        byId.add(validated.id)
        namesInBlock.add(validated.name)
      })
    } else if (block.variables !== undefined) {
      throw new Error(`Invalid Loom blocks[${index}].variables`)
    }
    if (!variablesByBlock.has(id)) variablesByBlock.set(id, new Map())
    blocksById.set(id, rawBlock as PromptBlockDTO)
  })
  finishRadioCategory()

  const promptValues = asRecord(record.promptVariableValues, 'promptVariableValues') as PromptVariableValuesDTO
  assertEnumerableDataProperties(promptValues, 'promptVariableValues')
  for (const blockId of Object.getOwnPropertyNames(promptValues)) {
    const variables = variablesByBlock.get(blockId)
    if (!variables) throw new Error(`Invalid Loom promptVariableValues block "${blockId}"`)
    const values = asRecord(promptValues[blockId], `promptVariableValues.${blockId}`)
    assertEnumerableDataProperties(values, `promptVariableValues.${blockId}`)
    for (const name of Object.getOwnPropertyNames(values)) {
      const candidates = variables.get(name)
      if (!candidates || candidates.length === 0) {
        throw new Error(`Invalid Loom promptVariableValues.${blockId}.${name}`)
      }
      let compatible = false
      for (const variable of candidates) {
        try {
          validatePromptVariableValue(values[name], variable, `promptVariableValues.${blockId}.${name}`)
          compatible = true
          break
        } catch {
          // A duplicate block occurrence may provide a compatible definition.
        }
      }
      if (!compatible) throw new Error(`Invalid Loom promptVariableValues.${blockId}.${name}`)
    }
  }
}

function isolateLoomClonePrototypes(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = isolateLoomClonePrototypes(value[index])
    }
    return value
  }
  if (value !== null && typeof value === 'object') {
    const isolated = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) {
        throw new Error('Invalid Loom value: clone property is not data')
      }
      Object.defineProperty(isolated, key, {
        value: isolateLoomClonePrototypes(descriptor.value),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return isolated
  }
  return value
}

export function cloneUnvalidatedLoomGraph(value: unknown): LoomGraphClone {
  preflightLoomValue(value)
  let clone: unknown
  try {
    clone = structuredClone(value)
  } catch {
    throw new Error('Invalid Loom value: unable to clone')
  }
  const isolatedClone = isolateLoomClonePrototypes(clone)
  const record = asRecord(isolatedClone, 'value')
  assertExactKeys(record, LOOM_VALUE_KEYS, 'value')
  if (!Object.prototype.hasOwnProperty.call(record, 'blocks')) throw new Error('Invalid Loom value.blocks')
  if (!Object.prototype.hasOwnProperty.call(record, 'promptVariableValues')) {
    throw new Error('Invalid Loom value.promptVariableValues')
  }
  return {
    blocks: record.blocks,
    promptVariableValues: record.promptVariableValues,
  }
}

export function cloneLoomValue(
  value: unknown,
  options?: LoomValueValidationOptions,
): SpindleLoomBlockEditorValue {
  validateLoomValue(value, options)
  let clone: unknown
  try {
    clone = structuredClone(value)
  } catch {
    throw new Error('Invalid Loom value: unable to clone')
  }
  const isolatedClone = isolateLoomClonePrototypes(clone)
  validateLoomValue(isolatedClone, options)
  return isolatedClone
}

export function cloneLoomOptions(options: unknown): NormalizedLoomOptions {
  const record = asRecord(options, 'options')
  assertExactKeys(record, LOOM_OPTION_KEYS, 'options')
  if (!Object.prototype.hasOwnProperty.call(record, 'value')) throw new Error('Invalid Loom options.value')
  const onChange = record.onChange
  if (onChange !== undefined && typeof onChange !== 'function') throw new Error('Invalid Loom options.onChange')
  if (record.readOnly !== undefined) assertBoolean(record.readOnly, 'options.readOnly')
  if (record.compact !== undefined) assertBoolean(record.compact, 'options.compact')
  return {
    value: cloneLoomValue(record.value),
    onChange: onChange as ((value: SpindleLoomBlockEditorValue) => void) | undefined,
    readOnly: record.readOnly === true,
    compact: record.compact !== false,
  }
}

export function patchLoomOptions(current: NormalizedLoomOptions, patch: unknown): NormalizedLoomOptions {
  const record = asRecord(patch, 'options patch')
  assertExactKeys(record, LOOM_OPTION_KEYS, 'options patch')
  const next: NormalizedLoomOptions = {
    value: current.value,
    onChange: current.onChange,
    readOnly: current.readOnly,
    compact: current.compact,
  }
  if (Object.prototype.hasOwnProperty.call(record, 'value')) next.value = cloneLoomValue(record.value)
  if (Object.prototype.hasOwnProperty.call(record, 'onChange')) {
    if (record.onChange !== undefined && typeof record.onChange !== 'function') {
      throw new Error('Invalid Loom options.onChange')
    }
    next.onChange = record.onChange as typeof next.onChange
  }
  if (Object.prototype.hasOwnProperty.call(record, 'readOnly')) {
    next.readOnly = assertBoolean(record.readOnly, 'options.readOnly')
  }
  if (Object.prototype.hasOwnProperty.call(record, 'compact')) {
    next.compact = assertBoolean(record.compact, 'options.compact')
  }
  return next
}

export function normalizeMacroCatalog(response: unknown, extensionIdentifier: string): MacroGroup[] {
  preflightMacroCatalog(response)
  const root = asRecord(response, 'macro catalog')
  assertEnumerableDataProperties(root, 'macro catalog')
  assertExactKeys(root, MACRO_CATALOG_KEYS, 'macro catalog')
  if (!Object.prototype.hasOwnProperty.call(root, 'categories')) throw new Error('Invalid Loom macro catalog categories')
  const categories = assertArray(root.categories, 'macro catalog.categories')
  const groups = categories.map((rawCategory, categoryIndex) => {
    const category = asRecord(rawCategory, `macro catalog.categories[${categoryIndex}]`)
    assertEnumerableDataProperties(category, `macro catalog.categories[${categoryIndex}]`)
    assertExactKeys(category, MACRO_CATEGORY_KEYS, `macro catalog.categories[${categoryIndex}]`)
    if (!Object.prototype.hasOwnProperty.call(category, 'category')) throw new Error(`Invalid Loom macro catalog category[${categoryIndex}]`)
    if (!Object.prototype.hasOwnProperty.call(category, 'macros')) throw new Error(`Invalid Loom macro catalog macros[${categoryIndex}]`)
    const categoryName = assertString(category.category, `macro catalog.categories[${categoryIndex}].category`)
    const macros = assertArray(category.macros, `macro catalog.categories[${categoryIndex}].macros`)
    return {
      category: categoryName,
      macros: macros.map((rawMacro, macroIndex) => {
        const macro = asRecord(rawMacro, `macro catalog.${categoryName}[${macroIndex}]`)
        assertEnumerableDataProperties(macro, `macro catalog.${categoryName}[${macroIndex}]`)
        assertExactKeys(macro, MACRO_ENTRY_KEYS, `macro catalog.${categoryName}[${macroIndex}]`)
        if (!Object.prototype.hasOwnProperty.call(macro, 'name')) throw new Error('Invalid Loom macro name')
        if (!Object.prototype.hasOwnProperty.call(macro, 'syntax')) throw new Error('Invalid Loom macro syntax')
        if (!Object.prototype.hasOwnProperty.call(macro, 'description')) throw new Error('Invalid Loom macro description')
        const entry = {
          name: assertString(macro.name, 'macro name'),
          syntax: assertString(macro.syntax, 'macro syntax'),
          description: assertString(macro.description, 'macro description'),
        } as MacroGroup['macros'][number]
        if (Object.prototype.hasOwnProperty.call(macro, 'category')) {
          assertOptionalString(macro.category, 'macro category')
        }
        if (Object.prototype.hasOwnProperty.call(macro, 'args')) {
          const args = assertArray(macro.args, 'macro args')
          entry.args = args.map((rawArg, argIndex) => {
            const arg = asRecord(rawArg, `macro args[${argIndex}]`)
            assertEnumerableDataProperties(arg, `macro args[${argIndex}]`)
            assertExactKeys(arg, MACRO_ARGUMENT_KEYS, `macro args[${argIndex}]`)
            if (!Object.prototype.hasOwnProperty.call(arg, 'name')) throw new Error('Invalid Loom macro argument name')
            const optional = Object.prototype.hasOwnProperty.call(arg, 'optional')
              ? assertBoolean(arg.optional, 'macro argument optional')
              : false
            return {
              name: assertString(arg.name, 'macro argument name'),
              optional,
            }
          })
        }
        if (Object.prototype.hasOwnProperty.call(macro, 'returns') && macro.returns !== undefined) {
          entry.returns = assertString(macro.returns, 'macro returns')
        }
        return entry
      }),
    }
  })
  const ownerIdentifier = assertString(extensionIdentifier, 'extension identifier').trim()
  if (ownerIdentifier.length === 0) throw new Error('Invalid Loom extension identifier')
  const ownerPrefix = `extension:${ownerIdentifier.toLowerCase()}`
  return groups.filter((group) => {
    const category = group.category.trim().toLowerCase()
    return !category.startsWith('extension:') || category === ownerPrefix || category.startsWith(`${ownerPrefix}:`)
  })
}
