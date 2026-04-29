import { get, post, put, del } from './client'

export interface LoadoutSnapshot {
  selectedDefinition: any | null
  selectedChimeraDefinitions: any[]
  selectedBehaviors: any[]
  selectedPersonalities: any[]
  chimeraMode: boolean
  lumiaQuirks: string
  lumiaQuirksEnabled: boolean
  councilSettings: any
  selectedLoomStyles: any[]
  selectedLoomUtils: any[]
  selectedLoomRetrofits: any[]
  oocEnabled: boolean
  lumiaOOCStyle: string
  lumiaOOCInterval: number | null
  sovereignHand: { enabled: boolean; excludeLastMessage: boolean; includeMessageInPrompt: boolean }
  contextFilters: any
}

export interface Loadout {
  id: string
  name: string
  snapshot: LoadoutSnapshot
  created_at: number
  updated_at: number
}

export interface LoadoutBinding {
  loadout_id: string
  bound_at: number
}

export interface ResolvedLoadout {
  loadout: Loadout | null
  source: 'chat' | 'character' | 'none'
}

export const loadoutsApi = {
  list() {
    return get<Loadout[]>('/loadouts')
  },

  create(name: string, snapshot?: LoadoutSnapshot) {
    return post<Loadout>('/loadouts', { name, snapshot })
  },

  update(id: string, body: { name?: string; recapture?: boolean }) {
    return put<Loadout>(`/loadouts/${id}`, body)
  },

  remove(id: string) {
    return del<void>(`/loadouts/${id}`)
  },

  apply(id: string) {
    return post<{ success: true }>(`/loadouts/${id}/apply`)
  },

  getCharacterBinding(characterId: string) {
    return get<LoadoutBinding>(`/loadouts/bindings/character/${characterId}`)
  },

  setCharacterBinding(characterId: string, loadoutId: string) {
    return put<LoadoutBinding>(`/loadouts/bindings/character/${characterId}`, { loadout_id: loadoutId })
  },

  deleteCharacterBinding(characterId: string) {
    return del<void>(`/loadouts/bindings/character/${characterId}`)
  },

  getChatBinding(chatId: string) {
    return get<LoadoutBinding>(`/loadouts/bindings/chat/${chatId}`)
  },

  setChatBinding(chatId: string, loadoutId: string) {
    return put<LoadoutBinding>(`/loadouts/bindings/chat/${chatId}`, { loadout_id: loadoutId })
  },

  deleteChatBinding(chatId: string) {
    return del<void>(`/loadouts/bindings/chat/${chatId}`)
  },

  resolve(chatId: string) {
    return get<ResolvedLoadout>(`/loadouts/resolve/${chatId}`)
  },
}
