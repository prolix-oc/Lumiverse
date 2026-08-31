import type { PresetProfileBinding } from '@/api/preset-profiles'
import type { PromptVariableValues } from '@/lib/loom/types'
import { commitRuntimeAuthorityMutation } from '@/lib/agentRuntimeSelection'

export type PresetProfilePromptVariableSource = 'chat' | 'persona' | 'character' | 'connection' | 'defaults'

export interface PresetProfilePromptVariableTarget {
  source: PresetProfilePromptVariableSource
  id: string
}

interface PresetProfilePromptVariableApi {
  updateChatPromptVariables(id: string, values: PromptVariableValues): Promise<PresetProfileBinding>
  updatePersonaPromptVariables(id: string, values: PromptVariableValues): Promise<PresetProfileBinding>
  updateCharacterPromptVariables(id: string, values: PromptVariableValues): Promise<PresetProfileBinding>
  updateConnectionPromptVariables(id: string, values: PromptVariableValues): Promise<PresetProfileBinding>
  updateDefaultsPromptVariables(id: string, values: PromptVariableValues): Promise<PresetProfileBinding>
}

export interface PresetProfilePromptVariableChange {
  target: PresetProfilePromptVariableTarget
  binding: PresetProfileBinding
}

const promptVariableChangeListeners = new Set<(change: PresetProfilePromptVariableChange) => void>()

export function subscribePresetProfilePromptVariableChanges(
  listener: (change: PresetProfilePromptVariableChange) => void,
): () => void {
  promptVariableChangeListeners.add(listener)
  return () => promptVariableChangeListeners.delete(listener)
}

function definePromptVariableEntry<T extends object>(target: T, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

/** Merge a scoped profile's explicit values over the preset configuration. */
export function mergePromptVariableValues(
  presetValues: PromptVariableValues,
  profileValues?: PromptVariableValues,
): PromptVariableValues {
  const merged: PromptVariableValues = {}
  for (const [blockId, values] of Object.entries(presetValues)) {
    const bucket: PromptVariableValues[string] = {}
    for (const [name, value] of Object.entries(values)) {
      definePromptVariableEntry(bucket, name, structuredClone(value))
    }
    definePromptVariableEntry(merged, blockId, bucket)
  }
  for (const [blockId, values] of Object.entries(profileValues ?? {})) {
    const inherited = Object.hasOwn(merged, blockId) ? merged[blockId] : undefined
    const bucket: PromptVariableValues[string] = {}
    if (inherited) {
      for (const [name, value] of Object.entries(inherited)) {
        definePromptVariableEntry(bucket, name, structuredClone(value))
      }
    }
    for (const [name, value] of Object.entries(values)) {
      definePromptVariableEntry(bucket, name, structuredClone(value))
    }
    definePromptVariableEntry(merged, blockId, bucket)
  }
  return merged
}

export function getEffectivePromptVariableValues(
  presetId: string | undefined,
  presetValues: PromptVariableValues,
  binding: PresetProfileBinding | null,
): PromptVariableValues {
  if (binding && presetId && binding.preset_id === presetId) {
    return mergePromptVariableValues(presetValues, binding.prompt_variables)
  }
  return presetValues
}

export async function updatePresetProfilePromptVariables(
  api: PresetProfilePromptVariableApi,
  target: PresetProfilePromptVariableTarget,
  values: PromptVariableValues,
): Promise<PresetProfileBinding> {
  let binding: PresetProfileBinding
  switch (target.source) {
    case 'chat':
      binding = await api.updateChatPromptVariables(target.id, values)
      break
    case 'persona':
      binding = await api.updatePersonaPromptVariables(target.id, values)
      break
    case 'character':
      binding = await api.updateCharacterPromptVariables(target.id, values)
      break
    case 'connection':
      binding = await api.updateConnectionPromptVariables(target.id, values)
      break
    case 'defaults':
      binding = await api.updateDefaultsPromptVariables(target.id, values)
      break
  }
  commitRuntimeAuthorityMutation()
  const change = { target, binding }
  for (const listener of promptVariableChangeListeners) {
    try {
      listener(change)
    } catch {
      // The profile write is already committed. A stale consumer must not
      // turn that successful save into a modal error.
    }
  }
  return binding
}
