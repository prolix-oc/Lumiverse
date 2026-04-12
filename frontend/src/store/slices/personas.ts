import type { StateCreator } from 'zustand'
import type { PersonasSlice } from '@/types/store'
import type { CharacterPersonaBinding } from '@/types/api'
import { settingsApi } from '@/api/settings'

/** Normalize a binding value to the object form. */
export function resolveBinding(val: string | CharacterPersonaBinding): CharacterPersonaBinding {
  return typeof val === 'string' ? { personaId: val } : val
}

export const createPersonasSlice: StateCreator<PersonasSlice> = (set, get) => ({
  personas: [],
  activePersonaId: null,
  characterPersonaBindings: {},
  personaSearchQuery: '',
  personaFilterType: 'all',
  personaSortField: 'name',
  personaSortDirection: 'asc',
  personaViewMode: 'grid',
  selectedPersonaId: null,

  setPersonas: (personas) =>
    set((s) => {
      let activePersonaId = s.activePersonaId

      if (activePersonaId && !personas.some((p) => p.id === activePersonaId)) {
        activePersonaId = personas.find((p) => p.is_default)?.id ?? null
        settingsApi.put('activePersonaId', activePersonaId).catch(() => {})
      }

      return { personas, activePersonaId }
    }),
  setActivePersona: (id) => {
    set({ activePersonaId: id })
    settingsApi.put('activePersonaId', id).catch(() => {})
  },
  setCharacterPersonaBinding: (characterId, personaId, addonStates) => {
    const bindings = { ...get().characterPersonaBindings }
    if (personaId) {
      bindings[characterId] = addonStates && Object.keys(addonStates).length > 0
        ? { personaId, addonStates }
        : personaId
    } else {
      delete bindings[characterId]
    }
    set({ characterPersonaBindings: bindings })
    settingsApi.put('characterPersonaBindings', bindings).catch(() => {})
  },
  addPersona: (persona) => set((s) => ({ personas: [...s.personas, persona] })),
  updatePersona: (id, persona) =>
    set((s) => {
      const existingIndex = s.personas.findIndex((p) => p.id === id)
      if (existingIndex === -1) return {}

      const personas = [...s.personas]
      personas[existingIndex] = persona
      return { personas }
    }),
  removePersona: (id) =>
    set((s) => {
      const personas = s.personas.filter((p) => p.id !== id)
      const selectedPersonaId = s.selectedPersonaId === id ? null : s.selectedPersonaId
      const activePersonaId = s.activePersonaId === id ? (personas.find((p) => p.is_default)?.id ?? null) : s.activePersonaId

      if (activePersonaId !== s.activePersonaId) {
        settingsApi.put('activePersonaId', activePersonaId).catch(() => {})
      }

      // Clean up character bindings that reference the deleted persona
      const bindings = { ...s.characterPersonaBindings }
      let bindingsChanged = false
      for (const [charId, val] of Object.entries(bindings)) {
        if (resolveBinding(val).personaId === id) {
          delete bindings[charId]
          bindingsChanged = true
        }
      }
      if (bindingsChanged) {
        settingsApi.put('characterPersonaBindings', bindings).catch(() => {})
      }

      return { personas, selectedPersonaId, activePersonaId, ...(bindingsChanged ? { characterPersonaBindings: bindings } : {}) }
    }),
  setPersonaSearchQuery: (query) => set({ personaSearchQuery: query }),
  setPersonaFilterType: (type) => {
    set({ personaFilterType: type })
    settingsApi.put('personaFilterType', type).catch(() => {})
  },
  setPersonaSortField: (field) => {
    set({ personaSortField: field })
    settingsApi.put('personaSortField', field).catch(() => {})
  },
  togglePersonaSortDirection: () =>
    set((s) => {
      const personaSortDirection = s.personaSortDirection === 'asc' ? 'desc' : 'asc'
      settingsApi.put('personaSortDirection', personaSortDirection).catch(() => {})
      return { personaSortDirection }
    }),
  setPersonaViewMode: (mode) => {
    set({ personaViewMode: mode })
    settingsApi.put('personaViewMode', mode).catch(() => {})
  },
  setSelectedPersonaId: (id) => set({ selectedPersonaId: id }),
})
