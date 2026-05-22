import { del, get, put } from './client'
import type {
  CouncilSettings,
  CouncilToolDefinition,
} from 'lumiverse-spindle-types'

export interface CouncilSidecarConfig {
  connectionProfileId: string
  model: string
  temperature: number
  topP: number
  maxTokens: number
}

export interface CouncilProfileBinding {
  council_settings: CouncilSettings
  sidecar_settings: CouncilSidecarConfig
  captured_at: number
}

export interface ResolvedCouncilProfile {
  binding: CouncilProfileBinding | null
  source: 'chat' | 'character' | 'defaults' | 'none'
  council_settings: CouncilSettings
  sidecar_settings: CouncilSidecarConfig
}

export const councilApi = {
  getSettings() {
    return get<CouncilSettings>('/council/settings')
  },

  putSettings(body: Partial<CouncilSettings>) {
    return put<CouncilSettings>('/council/settings', body)
  },

  getDefaults() {
    return get<CouncilProfileBinding>('/council/settings/defaults')
  },

  putDefaults(body: Partial<CouncilProfileBinding>) {
    return put<CouncilProfileBinding>('/council/settings/defaults', body)
  },

  deleteDefaults() {
    return del<void>('/council/settings/defaults')
  },

  getCharacterBinding(characterId: string) {
    return get<CouncilProfileBinding>(`/council/settings/character/${characterId}`)
  },

  putCharacterBinding(characterId: string, body: Partial<CouncilProfileBinding>) {
    return put<CouncilProfileBinding>(`/council/settings/character/${characterId}`, body)
  },

  deleteCharacterBinding(characterId: string) {
    return del<void>(`/council/settings/character/${encodeURIComponent(characterId)}`)
  },

  getChatBinding(chatId: string) {
    return get<CouncilProfileBinding>(`/council/settings/chat/${chatId}`)
  },

  putChatBinding(chatId: string, body: Partial<CouncilProfileBinding>) {
    return put<CouncilProfileBinding>(`/council/settings/chat/${chatId}`, body)
  },

  deleteChatBinding(chatId: string) {
    return del<void>(`/council/settings/chat/${encodeURIComponent(chatId)}`)
  },

  resolve(chatId: string) {
    return get<ResolvedCouncilProfile>(`/council/settings/resolve/${chatId}`)
  },

  getTools() {
    return get<CouncilToolDefinition[]>('/council/tools')
  },
}
