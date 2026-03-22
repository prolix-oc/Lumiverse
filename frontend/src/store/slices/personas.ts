import type { StateCreator } from 'zustand'
import type { PersonasSlice } from '@/types/store'
import { settingsApi } from '@/api/settings'

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
  setCharacterPersonaBinding: (characterId, personaId) => {
    const bindings = { ...get().characterPersonaBindings }
    if (personaId) {
      bindings[characterId] = personaId
    } else {
      delete bindings[characterId]
    }
    set({ characterPersonaBindings: bindings })
    settingsApi.put('characterPersonaBindings', bindings).catch(() => {})
  },
  addPersona: (persona) => set((s) => ({ personas: [...s.personas, persona] })),
  updatePersona: (id, persona) =>
    set((s) => ({ personas: s.personas.map((p) => (p.id === id ? persona : p)) })),
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
      for (const [charId, personaId] of Object.entries(bindings)) {
        if (personaId === id) {
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
