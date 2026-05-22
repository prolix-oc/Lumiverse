import { get, put, del } from './client'

export interface PresetProfileBinding {
  preset_id: string
  block_states: Record<string, boolean>
  captured_at: number
  linked_to_defaults?: boolean
}

export interface ResolvedPresetProfile {
  preset_id: string | null
  binding: PresetProfileBinding | null
  source: 'chat' | 'character' | 'connection' | 'defaults' | 'none'
}

export const presetProfilesApi = {
  // Defaults
  getDefaults(presetId: string) {
    return get<PresetProfileBinding>('/preset-profiles/defaults', { preset_id: presetId })
  },

  captureDefaults(presetId: string, blockStates: Record<string, boolean>) {
    return put<PresetProfileBinding>('/preset-profiles/defaults', {
      preset_id: presetId,
      block_states: blockStates,
    })
  },

  deleteDefaults(presetId: string) {
    return del<void>(`/preset-profiles/defaults?preset_id=${encodeURIComponent(presetId)}`)
  },

  // Character bindings
  getCharacterBinding(characterId: string) {
    return get<PresetProfileBinding>(`/preset-profiles/character/${characterId}`)
  },

  setCharacterBinding(characterId: string, presetId: string, blockStates: Record<string, boolean>) {
    return put<PresetProfileBinding>(`/preset-profiles/character/${characterId}`, {
      preset_id: presetId,
      block_states: blockStates,
    })
  },

  deleteCharacterBinding(characterId: string) {
    return del<void>(`/preset-profiles/character/${characterId}`)
  },

  // Chat bindings
  getChatBinding(chatId: string) {
    return get<PresetProfileBinding>(`/preset-profiles/chat/${chatId}`)
  },

  setChatBinding(chatId: string, presetId: string, blockStates: Record<string, boolean>) {
    return put<PresetProfileBinding>(`/preset-profiles/chat/${chatId}`, {
      preset_id: presetId,
      block_states: blockStates,
    })
  },

  deleteChatBinding(chatId: string) {
    return del<void>(`/preset-profiles/chat/${chatId}`)
  },

  // Connection profile bindings
  getConnectionBinding(connectionId: string) {
    return get<PresetProfileBinding>(`/preset-profiles/connection/${connectionId}`)
  },

  setConnectionBinding(connectionId: string, presetId: string, blockStates: Record<string, boolean>) {
    return put<PresetProfileBinding>(`/preset-profiles/connection/${connectionId}`, {
      preset_id: presetId,
      block_states: blockStates,
    })
  },

  deleteConnectionBinding(connectionId: string) {
    return del<void>(`/preset-profiles/connection/${connectionId}`)
  },

  // Resolution
  resolve(chatId: string, presetId?: string | null, connectionId?: string | null) {
    return get<ResolvedPresetProfile>(`/preset-profiles/resolve/${chatId}`, {
      ...(presetId ? { preset_id: presetId } : {}),
      ...(connectionId ? { connection_id: connectionId } : {}),
    })
  },
}
