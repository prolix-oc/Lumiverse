import type {
  SpindlePresetEditorDraft,
  SpindlePresetEditorExtensionState,
  SpindlePresetEditorScopedHelper,
  SpindlePresetEditorState,
} from './preset-editor-types'
import type { PromptVariableValueDTO, PromptVariableValuesDTO } from 'lumiverse-spindle-types'
import { isLoomOwnedPresetMetadataKey, projectPublicPromptBlocks, pruneOrphanPromptVariables } from '@/lib/loom/service'

type PresetMutator = (preset: SpindlePresetEditorDraft) => SpindlePresetEditorDraft

interface PresetEditorController {
  getState(): SpindlePresetEditorState
  getPromptVariableValues?(): PromptVariableValuesDTO
  setActiveTab(tabId: string): void
  updatePreset(mutator: PresetMutator, immediate: boolean): void
  flush(): Promise<void>
}

export interface PresetEditorScopedAccess {
  assertActive(): void
  trackSubscription(unsubscribe: () => void): () => void
}

const DEFAULT_STATE: SpindlePresetEditorState = {
  open: false,
  presetId: null,
  activeTabId: null,
  preset: null,
}

let controller: PresetEditorController | null = null
let snapshot: SpindlePresetEditorState = DEFAULT_STATE
let privatePromptVariableSnapshot: PromptVariableValuesDTO = {}
interface PublicationFrame {
  state: SpindlePresetEditorState
  promptVariableValues: PromptVariableValuesDTO
}
const publicationFrames: PublicationFrame[] = []
const listeners = new Set<(state: SpindlePresetEditorState) => void>()

function clone<T>(value: T): T {
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value)) as T
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function clonePublicDraft(draft: SpindlePresetEditorDraft): SpindlePresetEditorDraft {
  const cloned = clone(draft) as SpindlePresetEditorDraft & { promptVariables?: unknown }
  delete cloned.promptVariables
  if (isRecord(cloned.metadata)) delete cloned.metadata.promptVariables
  return cloned
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function isJsonValue(value: unknown, ancestors = new WeakSet<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (typeof value !== 'object') return false

  if (ancestors.has(value)) return false
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value) || !isJsonValue(value[index], ancestors)) return false
      }
      return Reflect.ownKeys(value).every((key) => (
        key === 'length'
        || (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length)
      ))
    }
    if (!isPlainObject(value)) return false
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== 'string') return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return !!descriptor
        && descriptor.enumerable
        && Object.hasOwn(descriptor, 'value')
        && isJsonValue(descriptor.value, ancestors)
    })
  } catch {
    return false
  } finally {
    ancestors.delete(value)
  }
}

function cloneState(state: SpindlePresetEditorState): SpindlePresetEditorState {
  return {
    open: state.open,
    presetId: state.presetId,
    activeTabId: state.activeTabId,
    preset: state.preset ? clonePublicDraft(state.preset) : null,
  }
}

function publishState(
  next: SpindlePresetEditorState,
  promptVariableValues: PromptVariableValuesDTO = {},
): void {
  const published = cloneState(next)
  const publishedPromptVariableValues = published.open && published.presetId && published.preset
    ? clonePublicPromptVariableValues(promptVariableValues) as PromptVariableValuesDTO
    : {}
  privatePromptVariableSnapshot = publishedPromptVariableValues
  snapshot = published
  const frame = { state: published, promptVariableValues: publishedPromptVariableValues }
  publicationFrames.push(frame)
  try {
    for (const handler of listeners) {
      try { handler(cloneState(published)) } catch { /* no-op */ }
    }
  } finally {
    publicationFrames.pop()
  }
}

function getCurrentState(): SpindlePresetEditorState {
  const frame = publicationFrames[publicationFrames.length - 1]
  return frame ? frame.state : !controller ? snapshot : controller.getState()
}

function getCurrentPromptVariableValues(): PromptVariableValuesDTO {
  const frame = publicationFrames[publicationFrames.length - 1]
  if (frame) return frame.promptVariableValues
  if (!controller) return privatePromptVariableSnapshot
  const state = controller.getState()
  if (!state.open || !state.presetId || !state.preset || !controller.getPromptVariableValues) return {}
  return controller.getPromptVariableValues()
}

function assertOpenController(): PresetEditorController {
  const current = getCurrentState()
  if (!controller || !current?.open || !current.preset) {
    throw new Error('PRESET_EDITOR_CLOSED: Preset editor is not open or has no selected preset')
  }
  return controller
}

export function setPresetEditorController(next: PresetEditorController | null): void {
  controller = next
  const state = next?.getState() ?? DEFAULT_STATE
  const promptVariableValues = next?.getPromptVariableValues?.() ?? {}
  syncPresetEditorState(state, promptVariableValues)
}

export function syncPresetEditorState(
  next: SpindlePresetEditorState,
  promptVariableValues?: PromptVariableValuesDTO,
): void {
  if (
    snapshot.open
    && snapshot.presetId
    && next.open
    && next.presetId
    && snapshot.presetId !== next.presetId
  ) {
    publishState(DEFAULT_STATE)
  }
  const values = next.open && next.presetId && next.preset
    ? promptVariableValues ?? controller?.getPromptVariableValues?.() ?? {}
    : {}
  publishState(next, values)
}

export function getPresetEditorState(): SpindlePresetEditorState {
  // A published transition snapshot is authoritative during listener delivery.
  return cloneState(getCurrentState())
}

export function subscribePresetEditorState(
  handler: (state: SpindlePresetEditorState) => void,
): () => void {
  listeners.add(handler)
  return () => { listeners.delete(handler) }
}

export function updatePresetEditorDraft(mutator: PresetMutator, immediate = false): void {
  assertOpenController().updatePreset((draft) => mutator(clonePublicDraft(draft)), immediate)
}

export async function flushPresetEditorDraft(): Promise<void> {
  const activeController = assertOpenController()
  await activeController.flush()
  if (controller === activeController) {
    const state = activeController.getState()
    syncPresetEditorState(state, activeController.getPromptVariableValues?.() ?? {})
  }
}

export function setPresetEditorActiveTab(tabId: string): void {
  assertOpenController().setActiveTab(tabId)
}


function cloneDenseStringArray(value: unknown): string[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (
      !lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
    ) return undefined
    const length = lengthDescriptor.value
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== length + 1) return undefined
    for (const key of ownKeys) {
      if (key === 'length') continue
      if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) return undefined
      const index = Number(key)
      if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) {
        return undefined
      }
    }
    const output: string[] = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (
        !descriptor
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, 'value')
        || typeof descriptor.value !== 'string'
      ) return undefined
      output.push(descriptor.value)
    }
    return output
  } catch {
    return undefined
  }
}

function clonePublicPromptVariableValues(
  value: unknown,
): SpindlePresetEditorExtensionState['promptVariableValues'] {
  const output = Object.create(null) as Record<string, Record<string, PromptVariableValueDTO>>
  try {
    if (!isPlainObject(value)) return output
    const blockKeys = Reflect.ownKeys(value)
    for (const blockKey of blockKeys) {
      if (typeof blockKey !== 'string') continue
      const blockId = blockKey
      let bucketDescriptor: PropertyDescriptor | undefined
      try {
        bucketDescriptor = Object.getOwnPropertyDescriptor(value, blockId)
      } catch {
        continue
      }
      if (!bucketDescriptor || !bucketDescriptor.enumerable || !('value' in bucketDescriptor)) continue
      let bucket: Record<string, unknown>
      try {
        if (!isPlainObject(bucketDescriptor.value)) continue
        bucket = bucketDescriptor.value
      } catch {
        continue
      }
      let bucketKeys: PropertyKey[]
      try {
        bucketKeys = Reflect.ownKeys(bucket)
      } catch {
        continue
      }
      const bucketOutput = Object.create(null) as Record<string, PromptVariableValueDTO>
      for (const bucketKey of bucketKeys) {
        if (typeof bucketKey !== 'string') continue
        const name = bucketKey
        let valueDescriptor: PropertyDescriptor | undefined
        try {
          valueDescriptor = Object.getOwnPropertyDescriptor(bucket, name)
        } catch {
          continue
        }
        if (!valueDescriptor || !valueDescriptor.enumerable || !('value' in valueDescriptor)) continue
        let clonedValue: PromptVariableValueDTO | undefined
        if (typeof valueDescriptor.value === 'string') {
          clonedValue = valueDescriptor.value
        } else if (
          typeof valueDescriptor.value === 'number'
          && Number.isFinite(valueDescriptor.value)
          && !Object.is(valueDescriptor.value, -0)
        ) {
          clonedValue = valueDescriptor.value
        } else {
          const clonedArray = cloneDenseStringArray(valueDescriptor.value)
          if (clonedArray !== undefined) clonedValue = clonedArray
        }
        if (clonedValue === undefined) continue
        Object.defineProperty(bucketOutput, name, {
          value: clonedValue,
          enumerable: true,
          configurable: true,
          writable: true,
        })
      }
      if (Object.keys(bucketOutput).length > 0) {
        Object.defineProperty(output, blockId, {
          value: bucketOutput,
          enumerable: true,
          configurable: true,
          writable: true,
        })
      }
    }
  } catch {
    return Object.create(null) as SpindlePresetEditorExtensionState['promptVariableValues']
  }
  return output as SpindlePresetEditorExtensionState['promptVariableValues']
}

function cloneExtensionState(
  state: SpindlePresetEditorState,
  extensionIdentifier: string,
  promptVariableValues: PromptVariableValuesDTO,
): SpindlePresetEditorExtensionState {
  const draft = state.preset
  const metadata = draft && Object.hasOwn(draft.metadata, extensionIdentifier)
    ? clone(draft.metadata[extensionIdentifier])
    : undefined
  const publicBlocks = draft ? projectPublicPromptBlocks(draft.blocks) : []
  const safePromptVariableValues = clonePublicPromptVariableValues(promptVariableValues)
  const prunedPromptVariableValues = draft
    ? pruneOrphanPromptVariables(
      safePromptVariableValues as unknown as Parameters<typeof pruneOrphanPromptVariables>[0],
      publicBlocks as unknown as Parameters<typeof pruneOrphanPromptVariables>[1],
    )
    : {}
  return {
    open: state.open,
    presetId: state.presetId,
    activeTabId: state.activeTabId,
    blocks: publicBlocks,
    promptVariableValues: clonePublicPromptVariableValues(prunedPromptVariableValues),
    metadata,
  }
}

function assertMetadataObject(value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainObject(value) || !isJsonValue(value)) {
    throw new Error('PRESET_EDITOR_INVALID_METADATA: Extension metadata must be a plain JSON object')
  }
}

/**
 * Create the cooperative, extension-identifier-scoped editor facade. This
 * constrains supported API mutations; it is not a sandbox for same-origin code.
 */
export function createPresetEditorScopedHelper(
  extensionIdentifier: string,
  access: PresetEditorScopedAccess,
): SpindlePresetEditorScopedHelper {
  if (isLoomOwnedPresetMetadataKey(extensionIdentifier)) {
    throw new Error(`PRESET_EDITOR_RESERVED_METADATA_KEY: ${extensionIdentifier}`)
  }

  function applyScopedMetadataMutation(
    mutator: (current: unknown) => Record<string, unknown>,
    immediate = false,
  ): void {
    access.assertActive()
    updatePresetEditorDraft((draft) => {
      const nextMetadata = mutator(
        Object.hasOwn(draft.metadata, extensionIdentifier)
          ? clone(draft.metadata[extensionIdentifier])
          : undefined,
      )
      assertMetadataObject(nextMetadata)
      return {
        ...draft,
        metadata: {
          ...draft.metadata,
          [extensionIdentifier]: clone(nextMetadata),
        },
      }
    }, immediate)
  }

  return {
    getState(): SpindlePresetEditorExtensionState {
      access.assertActive()
      const state = getPresetEditorState()
      return cloneExtensionState(state, extensionIdentifier, getCurrentPromptVariableValues())
    },
    onChange(handler: (state: SpindlePresetEditorExtensionState) => void): () => void {
      access.assertActive()
      const unsubscribe = subscribePresetEditorState((state) => {
        handler(cloneExtensionState(state, extensionIdentifier, getCurrentPromptVariableValues()))
      })
      return access.trackSubscription(unsubscribe)
    },
    setMetadata(value, options): void {
      assertMetadataObject(value)
      applyScopedMetadataMutation(() => value, options?.immediate === true)
    },
    updateMetadata(mutator, options): void {
      applyScopedMetadataMutation(mutator, options?.immediate === true)
    },
    activateBuiltinTab(tab): void {
      access.assertActive()
      if (tab !== 'blocks') throw new Error(`PRESET_EDITOR_UNKNOWN_BUILTIN_TAB:${tab}`)
      setPresetEditorActiveTab('preset')
    },
    flush(): Promise<void> {
      access.assertActive()
      return flushPresetEditorDraft()
    },
  }
}
