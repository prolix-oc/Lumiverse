import { get, put, del } from './client'

export interface PresetProfileBinding {
  preset_id: string
  block_states: Record<string, boolean>
  captured_at: number
}

export interface ResolvedPresetProfile {
  binding: PresetProfileBinding | null
  source: 'chat' | 'character' | 'defaults' | 'none'
}

export const presetProfilesApi = {
  // Defaults
  getDefaults() {
    return get<PresetProfileBinding>('/preset-profiles/defaults')
  },

  captureDefaults(presetId: string, blockStates: Record<string, boolean>) {
    return put<PresetProfileBinding>('/preset-profiles/defaults', {
      preset_id: presetId,
      block_states: blockStates,
    })
  },

  deleteDefaults() {
    return del<void>('/preset-profiles/defaults')
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

  // Resolution
  resolve(chatId: string, presetId: string) {
    return get<ResolvedPresetProfile>(`/preset-profiles/resolve/${chatId}`, { preset_id: presetId })
  },
}
