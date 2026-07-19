import type {
  PromptBlockDTO,
  PromptVariableDefDTO,
  PromptVariableValueDTO,
  PromptVariableValuesDTO,
} from 'lumiverse-spindle-types'
import type { Preset } from '@/types/api'
import type { LoomPreset, PromptBlock, PromptVariableDef } from '@/lib/loom/types'
import { marshalUpdate, unmarshalPreset } from '@/lib/loom/service'
import { cloneLoomValue, cloneUnvalidatedLoomGraph, HOST_ONLY_BLOCK_FIELDS, LOOM_DTO_LIMITS } from './loom-dto'
import type { SpindlePresetEditorDraft } from './preset-editor-types'

type DataProperty = { present: true; value: unknown } | { present: false; value?: undefined }

const PUBLIC_BLOCK_KEYS = [
  'id',
  'name',
  'content',
  'role',
  'enabled',
  'position',
  'depth',
  'marker',
  'isLocked',
  'color',
  'injectionTrigger',
  'characterTagTrigger',
  'group',
  'categoryMode',
] as const

const PUBLIC_VARIABLE_KEYS = [
  'id',
  'name',
  'label',
  'type',
  'defaultValue',
  'description',
  'rows',
  'min',
  'max',
  'step',
  'options',
  'separator',
] as const

const PUBLIC_OPTION_KEYS = ['id', 'label', 'value'] as const

const HOST_BLOCK_FIELDS = HOST_ONLY_BLOCK_FIELDS

const DRAFT_KEYS = [
  'id',
  'name',
  'blocks',
  'parameters',
  'prompts',
  'metadata',
  'createdAt',
  'updatedAt',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function assertKnownKeys(value: unknown, label: string, allowed: readonly string[]): void {
  if (!isRecord(value)) throw new Error(`Invalid Loom ${label}`)
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`Invalid Loom ${label}: unknown symbol field`)
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.some((candidate) => candidate === key)) {
      throw new Error(`Invalid Loom ${label}: unknown field "${key}"`)
    }
  }
}

function ownData(value: unknown, key: string, label: string, required = false): DataProperty {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Loom ${label}`)
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor) {
    if (required) throw new Error(`Invalid Loom ${label}.${key}`)
    return { present: false }
  }
  if (!('value' in descriptor) || descriptor.enumerable !== true) {
    throw new Error(`Invalid Loom ${label}.${key}: must be an enumerable data property`)
  }
  return { present: true, value: descriptor.value }
}

function ownArrayElements(
  value: unknown,
  label: string,
  limit?: keyof typeof LOOM_DTO_LIMITS,
): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`Invalid Loom ${label}`)
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (!lengthDescriptor || !('value' in lengthDescriptor)) throw new Error(`Invalid Loom ${label}`)
  const length = lengthDescriptor.value
  if (!Number.isSafeInteger(length) || length < 0) throw new Error(`Invalid Loom ${label}`)
  if (limit && length > LOOM_DTO_LIMITS[limit]) {
    throw new Error(`Invalid Loom ${label}: collection exceeds ${limit} limit`)
  }
  const result: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`Invalid Loom ${label}[${index}]: must be an enumerable data property`)
    }
    result.push(descriptor.value)
  }
  return result
}

function putPublicField(target: Record<string, unknown>, source: unknown, key: string, label: string): void {
  const entry = ownData(source, key, label)
  if (entry.present) target[key] = entry.value
}

function projectPublicVariableOption(value: unknown, label: string): Record<string, unknown> {
  assertKnownKeys(value, label, PUBLIC_OPTION_KEYS)
  const target: Record<string, unknown> = {}
  for (const key of PUBLIC_OPTION_KEYS) putPublicField(target, value, key, label)
  return target
}

function projectPublicVariable(value: unknown, label: string): Record<string, unknown> {
  assertKnownKeys(value, label, PUBLIC_VARIABLE_KEYS)
  const target: Record<string, unknown> = {}
  for (const key of PUBLIC_VARIABLE_KEYS) {
    if (key === 'options') continue
    putPublicField(target, value, key, label)
  }
  const options = ownData(value, 'options', label)
  if (options.present) {
    target.options = ownArrayElements(options.value, `${label}.options`, 'maxOptionsPerVariable')
      .map((option, index) => projectPublicVariableOption(option, `${label}.options[${index}]`))
  }
  return target
}

function projectPublicBlock(value: unknown, label: string): PromptBlockDTO {
  assertKnownKeys(value, label, [...PUBLIC_BLOCK_KEYS, 'variables', ...HOST_BLOCK_FIELDS])
  const target: Record<string, unknown> = {}
  for (const key of PUBLIC_BLOCK_KEYS) putPublicField(target, value, key, label)
  const variables = ownData(value, 'variables', label)
  if (variables.present && variables.value !== undefined) {
    target.variables = ownArrayElements(variables.value, `${label}.variables`, 'maxVariablesPerBlock')
      .map((variable, index) => projectPublicVariable(variable, `${label}.variables[${index}]`))
  }
  return target as unknown as PromptBlockDTO
}

function projectPublicBlocks(value: unknown, label: string): PromptBlockDTO[] {
  return ownArrayElements(value, label, 'maxBlocks')
    .map((block, index) => projectPublicBlock(block, `${label}[${index}]`))
}

function hasLegacyVariableShape(block: PromptBlock): boolean {
  if (!Array.isArray(block.variables)) return false
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const variable of block.variables) {
    if (!variable.id || !variable.name || ids.has(variable.id) || names.has(variable.name)) return true
    ids.add(variable.id)
    names.add(variable.name)
  }
  return false
}

function sameVariableIdentityGraph(current: PromptBlock, draft: PromptBlockDTO): boolean {
  if (current.variables === undefined || draft.variables === undefined) {
    return current.variables === undefined && draft.variables === undefined
  }
  if (!Array.isArray(current.variables) || !Array.isArray(draft.variables)) return false
  if (current.variables.length !== draft.variables.length) return false
  return current.variables.every((variable, index) => (
    variable.id === draft.variables?.[index]?.id
    && variable.name === draft.variables?.[index]?.name
  ))
}

function findLegacyBlockIds(currentBlocks: PromptBlock[], draftBlocks: PromptBlockDTO[]): Set<string> {
  const currentCounts = new Map<string, number>()
  const draftCounts = new Map<string, number>()
  for (const block of currentBlocks) currentCounts.set(block.id, (currentCounts.get(block.id) ?? 0) + 1)
  for (const block of draftBlocks) draftCounts.set(block.id, (draftCounts.get(block.id) ?? 0) + 1)
  return new Set(
    [...currentCounts]
      .filter(([id, count]) => count > 1 && draftCounts.get(id) === count)
      .map(([id]) => id),
  )
}

function legacyVariableBlockIndexes(
  currentBlocks: PromptBlock[],
  draftBlocks: PromptBlockDTO[],
): Set<number> {
  const currentById = new Map<string, PromptBlock[]>()
  for (const block of currentBlocks) {
    const entries = currentById.get(block.id) ?? []
    entries.push(block)
    currentById.set(block.id, entries)
  }
  const occurrences = new Map<string, number>()
  const allowed = new Set<number>()
  draftBlocks.forEach((draft, index) => {
    const occurrence = occurrences.get(draft.id) ?? 0
    occurrences.set(draft.id, occurrence + 1)
    const current = currentById.get(draft.id)?.[occurrence]
    if (current && hasLegacyVariableShape(current) && sameVariableIdentityGraph(current, draft)) {
      allowed.add(index)
    }
  })
  return allowed
}

function samePublicBlock(current: PromptBlock, draft: PromptBlockDTO): boolean {
  try {
    return JSON.stringify(projectPublicBlock(current, 'current block')) === JSON.stringify(draft)
  } catch {
    return false
  }
}

function assertLegacyDuplicateOccurrenceSafety(
  currentBlocks: PromptBlock[],
  draftBlocks: PromptBlockDTO[],
): void {
  const currentById = new Map<string, PromptBlock[]>()
  const draftById = new Map<string, PromptBlockDTO[]>()
  for (const block of currentBlocks) {
    const entries = currentById.get(block.id) ?? []
    entries.push(block)
    currentById.set(block.id, entries)
  }
  for (const block of draftBlocks) {
    const entries = draftById.get(block.id) ?? []
    entries.push(block)
    draftById.set(block.id, entries)
  }

  for (const [id, currentOccurrences] of currentById) {
    if (currentOccurrences.length < 2) continue
    const nextOccurrences = draftById.get(id) ?? []
    if (nextOccurrences.length !== currentOccurrences.length) {
      throw new Error(`LOOM_AMBIGUOUS_BLOCK_OCCURRENCE: duplicate block "${id}" changed occurrence count`)
    }

    const identitySignatures = currentOccurrences.map((block) => (
      currentBlocks.length > 0
        ? JSON.stringify((block.variables ?? []).map((variable) => ({ id: variable.id, name: variable.name })))
        : ''
    ))
    const signatureCounts = new Map<string, number>()
    for (const signature of identitySignatures) {
      signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1)
    }

    for (let occurrence = 0; occurrence < currentOccurrences.length; occurrence += 1) {
      const current = currentOccurrences[occurrence]!
      const draft = nextOccurrences[occurrence]!
      if (!sameVariableIdentityGraph(current, draft)) {
        throw new Error(`LOOM_AMBIGUOUS_BLOCK_OCCURRENCE: duplicate block "${id}" identity changed`)
      }
      const signature = identitySignatures[occurrence]!
      if (signatureCounts.get(signature)! > 1 && !samePublicBlock(current, draft)) {
        throw new Error(`LOOM_AMBIGUOUS_BLOCK_OCCURRENCE: duplicate block "${id}" has indistinguishable occurrences`)
      }
      const reordered = currentOccurrences.some((candidate, candidateIndex) => (
        candidateIndex !== occurrence && samePublicBlock(candidate, draft)
      ))
      if (reordered) {
        throw new Error(`LOOM_AMBIGUOUS_BLOCK_OCCURRENCE: duplicate block "${id}" was reordered`)
      }
    }
  }
}

function readPromptBucket(values: unknown, blockId: string, label: string): Record<string, unknown> | null {
  if (!isRecord(values)) throw new Error(`Invalid Loom ${label}`)
  const descriptor = ownData(values, blockId, `${label}.${blockId}`)
  if (!descriptor.present) return null
  if (!isRecord(descriptor.value)) throw new Error(`Invalid Loom ${label}.${blockId}`)
  return descriptor.value
}

function clonePromptArray(value: unknown, label: string): string[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
  const entries = ownArrayElements(value, label, 'maxPromptValuesPerBucket')
  const cloned: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string') return null
    cloned.push(entry)
  }
  return cloned
}

type PromptVariableDTO = PromptVariableDefDTO

function compatiblePromptValue(variable: PromptVariableDTO, value: unknown, label: string): PromptVariableValueDTO | undefined {
  if (variable.type === 'text' || variable.type === 'textarea' || variable.type === 'select') {
    if (typeof value !== 'string') return undefined
    if (variable.type === 'select' && !variable.options.some((option) => option.id === value)) return undefined
    return value
  }
  if (variable.type === 'number' || variable.type === 'slider') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    if (variable.min !== undefined && value < variable.min) return undefined
    if (variable.max !== undefined && value > variable.max) return undefined
    return value
  }
  if (variable.type === 'switch') return value === 0 || value === 1 ? value : undefined
  const values = clonePromptArray(value, label)
  if (!values) return undefined
  const options = variable.options.map((option) => option.id)
  if (new Set(values).size !== values.length) return undefined
  return values.every((entry) => options.includes(entry)) ? values : undefined
}

function reconcilePromptValues(
  values: unknown,
  previousBlocks: PromptBlock[],
  nextBlocks: PromptBlockDTO[],
): PromptVariableValuesDTO {
  if (!isRecord(values)) throw new Error('Invalid Loom promptVariableValues')
  const previousById = new Map<string, PromptBlock[]>()
  for (const block of previousBlocks) {
    const entries = previousById.get(block.id) ?? []
    entries.push(block)
    previousById.set(block.id, entries)
  }
  const nextOccurrences = new Map<string, number>()
  const output: PromptVariableValuesDTO = Object.create(null)
  for (const block of nextBlocks) {
    const occurrence = nextOccurrences.get(block.id) ?? 0
    nextOccurrences.set(block.id, occurrence + 1)
    if (!Array.isArray(block.variables) || block.variables.length === 0) continue
    const sourceBucket = readPromptBucket(values, block.id, 'promptVariableValues')
    if (!sourceBucket) continue
    const previous = previousById.get(block.id)?.[occurrence]
    const previousVariables = previous?.variables ?? []
    const idCounts = new Map<string, number>()
    for (const variable of previousVariables) idCounts.set(variable.id, (idCounts.get(variable.id) ?? 0) + 1)
    const existing = readPromptBucket(output, block.id, 'promptVariableValues')
    const kept: Record<string, PromptVariableValueDTO> = existing ?? Object.create(null)
    for (const [index, variable] of (block.variables as PromptVariableDTO[]).entries()) {
      const occurrenceVariable = previousVariables[index]
      const previousVariable = occurrenceVariable?.id === variable.id
        ? occurrenceVariable
        : idCounts.get(variable.id) === 1
          ? previousVariables.find((candidate) => candidate.id === variable.id)
          : undefined
      const sourceName = previousVariable?.name ?? variable.name
      const source = ownData(sourceBucket, sourceName, `promptVariableValues.${block.id}.${sourceName}`)
      if (!source.present) continue
      const compatible = compatiblePromptValue(variable, source.value, `promptVariableValues.${block.id}.${sourceName}`)
      if (compatible === undefined) continue
      Object.defineProperty(kept, variable.name, {
        value: compatible,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    if (!existing) {
      Object.defineProperty(output, block.id, {
        value: kept,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
  }
  return output
}

function mergeHostBlockFields(current: PromptBlock | undefined, block: PromptBlockDTO): PromptBlock {
  const merged: Record<string, unknown> = { ...block }
  if (current) {
    for (const key of HOST_BLOCK_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor && 'value' in descriptor) merged[key] = structuredClone(descriptor.value)
    }
  }
  return merged as unknown as PromptBlock
}

export function toPresetEditorDraft(preset: LoomPreset): SpindlePresetEditorDraft {
  const raw = marshalUpdate(preset)
  const metadata = structuredClone(raw.metadata ?? {}) as Record<string, unknown>
  delete metadata.promptVariables
  return {
    id: preset.id,
    name: preset.name,
    blocks: structuredClone(projectPublicBlocks(raw.prompt_order ?? [], 'preset.prompt_order')),
    parameters: structuredClone(raw.parameters ?? {}),
    prompts: structuredClone(raw.prompts ?? {}),
    metadata,
    createdAt: preset.createdAt,
    updatedAt: preset.updatedAt,
  } as SpindlePresetEditorDraft
}

export function applyPresetEditorDraft(
  current: LoomPreset,
  draft: SpindlePresetEditorDraft,
): LoomPreset {
  if (
    draft === null
    || typeof draft !== 'object'
    || Array.isArray(draft)
    || (Object.getPrototypeOf(draft) !== Object.prototype && Object.getPrototypeOf(draft) !== null)
    || Object.getOwnPropertySymbols(draft).length > 0
  ) {
    throw new Error('Invalid Loom draft')
  }
  assertKnownKeys(draft, 'draft', DRAFT_KEYS)
  const draftId = ownData(draft, 'id', 'draft', true).value
  if (draftId !== current.id) throw new Error('Preset draft id cannot be changed')
  const draftName = ownData(draft, 'name', 'draft', true).value
  if (typeof draftName !== 'string' || !draftName.trim()) throw new Error('Preset name is required')
  const draftBlocks = ownData(draft, 'blocks', 'draft', true).value
  const draftParameters = ownData(draft, 'parameters', 'draft', true).value
  const draftPrompts = ownData(draft, 'prompts', 'draft', true).value
  const draftMetadata = ownData(draft, 'metadata', 'draft', true).value
  ownData(draft, 'createdAt', 'draft', true)
  ownData(draft, 'updatedAt', 'draft', true)
  if (!isRecord(draftParameters) || !isRecord(draftPrompts) || !isRecord(draftMetadata)) {
    throw new Error('Preset parameters, prompts, and metadata must be objects')
  }

  const detachedDraft = cloneUnvalidatedLoomGraph({
    blocks: draftBlocks,
    promptVariableValues: current.promptVariables ?? {},
  })
  const projectedBlocks = projectPublicBlocks(detachedDraft.blocks, 'draft.blocks')
  assertLegacyDuplicateOccurrenceSafety(current.blocks, projectedBlocks)
  const legacyBlockIds = findLegacyBlockIds(current.blocks, projectedBlocks)
  const legacyVariableIndexes = legacyVariableBlockIndexes(current.blocks, projectedBlocks)
  const validationOptions = {
    legacyDuplicateBlockIds: legacyBlockIds,
    legacyDuplicateVariableBlockIndexes: legacyVariableIndexes,
  } as const
  const detachedBlocks = cloneLoomValue({
    blocks: projectedBlocks,
    promptVariableValues: {},
  }, validationOptions).blocks

  const reconciled = reconcilePromptValues(detachedDraft.promptVariableValues, current.blocks, detachedBlocks)
  const detached = cloneLoomValue({
    blocks: detachedBlocks,
    promptVariableValues: reconciled,
  }, validationOptions)

  const currentBlocksById = new Map<string, PromptBlock[]>()
  for (const block of current.blocks) {
    const entries = currentBlocksById.get(block.id) ?? []
    entries.push(block)
    currentBlocksById.set(block.id, entries)
  }
  const currentOccurrences = new Map<string, number>()
  const blocks = detached.blocks.map((block) => {
    const occurrence = currentOccurrences.get(block.id) ?? 0
    currentOccurrences.set(block.id, occurrence + 1)
    return mergeHostBlockFields(currentBlocksById.get(block.id)?.[occurrence], block)
  })
  const now = Date.now()
  const raw: Preset = {
    id: current.id,
    name: (draftName as string).trim(),
    provider: 'loom',
    parameters: structuredClone(draftParameters),
    prompt_order: blocks,
    prompts: structuredClone(draftPrompts),
    metadata: {
      ...structuredClone(draftMetadata),
      promptVariables: structuredClone(detached.promptVariableValues),
    },
    created_at: current.createdAt,
    ...(typeof current.cacheRevision === 'number' ? { cache_revision: current.cacheRevision } : {}),
    updated_at: now,
  }
  const next = unmarshalPreset(raw)
  next.createdAt = current.createdAt
  next.updatedAt = now
  return next
}
