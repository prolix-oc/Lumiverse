import { get, put, patch, del } from './client'
import type { PromptVariableValues } from '@/lib/loom/types'
import { shareRead } from '@/lib/shared-read'

function read<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  return shareRead(`profile:${path}:${JSON.stringify(params ?? {})}`, () => get<T>(path, params))
}

export type PresetProfileContext = Record<'defaults' | 'chat' | 'persona' | 'character' | 'connection', PresetProfileBinding | null>

export interface PresetProfileBinding {
  preset_id: string
  block_states: Record<string, boolean>
  prompt_variables?: PromptVariableValues
  captured_at: number
  linked_to_defaults?: boolean
}

export interface ResolvedPresetProfile {
  preset_id: string | null
  binding: PresetProfileBinding | null
  source: 'chat' | 'persona' | 'character' | 'connection' | 'defaults' | 'none'
  source_id: string | null
}

export const presetProfilesApi = {
  context(params: { preset_id?: string; chat_id?: string; persona_id?: string; character_id?: string; connection_id?: string; is_group?: boolean; revision?: number }) {
    return read<PresetProfileContext>('/preset-profiles/context', params)
  },
  // Defaults
  getDefaults(presetId: string) {
    return read<PresetProfileBinding>('/preset-profiles/defaults', { preset_id: presetId })
  },

  captureDefaults(presetId: string, blockStates: Record<string, boolean>, promptVariables?: PromptVariableValues) {
    return put<PresetProfileBinding>('/preset-profiles/defaults', {
      preset_id: presetId,
      block_states: blockStates,
      ...(promptVariables ? { prompt_variables: promptVariables } : {}),
    })
  },

  deleteDefaults(presetId: string) {
    return del<void>(`/preset-profiles/defaults?preset_id=${encodeURIComponent(presetId)}`)
  },

  updateDefaultsPromptVariables(presetId: string, promptVariables: PromptVariableValues) {
    return patch<PresetProfileBinding>('/preset-profiles/defaults/prompt-variables', {
      preset_id: presetId,
      prompt_variables: promptVariables,
    })
  },

  // Character bindings
  getCharacterBinding(characterId: string) {
    return read<PresetProfileBinding>(`/preset-profiles/character/${characterId}`)
  },

  setCharacterBinding(characterId: string, presetId: string, blockStates: Record<string, boolean>, promptVariables?: PromptVariableValues) {
    return put<PresetProfileBinding>(`/preset-profiles/character/${characterId}`, {
      preset_id: presetId,
      block_states: blockStates,
      ...(promptVariables ? { prompt_variables: promptVariables } : {}),
    })
  },

  deleteCharacterBinding(characterId: string) {
    return del<void>(`/preset-profiles/character/${characterId}`)
  },

  updateCharacterPromptVariables(characterId: string, promptVariables: PromptVariableValues) {
    return patch<PresetProfileBinding>(`/preset-profiles/character/${characterId}/prompt-variables`, {
      prompt_variables: promptVariables,
    })
  },

  // Persona bindings
  getPersonaBinding(personaId: string) {
    return read<PresetProfileBinding>(`/preset-profiles/persona/${personaId}`)
  },

  setPersonaBinding(personaId: string, presetId: string, blockStates: Record<string, boolean>, promptVariables?: PromptVariableValues) {
    return put<PresetProfileBinding>(`/preset-profiles/persona/${personaId}`, {
      preset_id: presetId,
      block_states: blockStates,
      ...(promptVariables ? { prompt_variables: promptVariables } : {}),
    })
  },

  deletePersonaBinding(personaId: string) {
    return del<void>(`/preset-profiles/persona/${personaId}`)
  },

  updatePersonaPromptVariables(personaId: string, promptVariables: PromptVariableValues) {
    return patch<PresetProfileBinding>(`/preset-profiles/persona/${personaId}/prompt-variables`, {
      prompt_variables: promptVariables,
    })
  },

  // Chat bindings
  getChatBinding(chatId: string) {
    return read<PresetProfileBinding>(`/preset-profiles/chat/${chatId}`)
  },

  setChatBinding(chatId: string, presetId: string, blockStates: Record<string, boolean>, promptVariables?: PromptVariableValues) {
    return put<PresetProfileBinding>(`/preset-profiles/chat/${chatId}`, {
      preset_id: presetId,
      block_states: blockStates,
      ...(promptVariables ? { prompt_variables: promptVariables } : {}),
    })
  },

  updateChatPromptVariables(chatId: string, promptVariables: PromptVariableValues) {
    return patch<PresetProfileBinding>(`/preset-profiles/chat/${chatId}/prompt-variables`, {
      prompt_variables: promptVariables,
    })
  },

  deleteChatBinding(chatId: string) {
    return del<void>(`/preset-profiles/chat/${chatId}`)
  },

  // Connection profile bindings
  getConnectionBinding(connectionId: string) {
    return read<PresetProfileBinding>(`/preset-profiles/connection/${connectionId}`)
  },

  setConnectionBinding(connectionId: string, presetId: string, blockStates: Record<string, boolean>, promptVariables?: PromptVariableValues) {
    return put<PresetProfileBinding>(`/preset-profiles/connection/${connectionId}`, {
      preset_id: presetId,
      block_states: blockStates,
      ...(promptVariables ? { prompt_variables: promptVariables } : {}),
    })
  },

  deleteConnectionBinding(connectionId: string) {
    return del<void>(`/preset-profiles/connection/${connectionId}`)
  },

  updateConnectionPromptVariables(connectionId: string, promptVariables: PromptVariableValues) {
    return patch<PresetProfileBinding>(`/preset-profiles/connection/${connectionId}/prompt-variables`, {
      prompt_variables: promptVariables,
    })
  },

  // Resolution
  resolve(chatId: string, presetId?: string | null, connectionId?: string | null, personaId?: string | null) {
    return read<ResolvedPresetProfile>(`/preset-profiles/resolve/${chatId}`, {
      ...(presetId ? { preset_id: presetId } : {}),
      ...(connectionId ? { connection_id: connectionId } : {}),
      ...(personaId ? { persona_id: personaId } : {}),
    })
  },
}
