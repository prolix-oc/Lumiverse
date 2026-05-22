import type { StateCreator } from 'zustand'
import type { CharacterPersonaBinding, Persona } from '@/types/api'
import type { PersonaTagBinding, PersonasSlice, ResolvedPersonaBinding } from '@/types/store'
import { settingsApi } from '@/api/settings'

/** Normalize a binding value to the object form. */
export function resolveBinding(val: string | CharacterPersonaBinding): CharacterPersonaBinding {
  return typeof val === 'string' ? { personaId: val } : val
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase()
}

function sanitizeAddonStates(addonStates?: Record<string, boolean>): Record<string, boolean> | undefined {
  if (!addonStates || typeof addonStates !== 'object') return undefined
  const entries = Object.entries(addonStates).filter(([key, value]) => key && typeof value === 'boolean')
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries)
}

export function resolvePersonaTagBinding(val: unknown): PersonaTagBinding | null {
  if (!val || typeof val !== 'object') return null
  const raw = val as Partial<PersonaTagBinding>
  const tags = Array.isArray(raw.tags)
    ? raw.tags
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim())
        .filter(Boolean)
        .filter((tag, index, arr) => arr.findIndex((candidate) => normalizeTag(candidate) === normalizeTag(tag)) === index)
    : []
  if (tags.length === 0) return null
  return {
    tags,
    mode: raw.mode === 'all' ? 'all' : 'any',
    addonStates: sanitizeAddonStates(raw.addonStates),
  }
}

export function characterMatchesPersonaTagBinding(characterTags: string[], binding: PersonaTagBinding | null | undefined): boolean {
  const resolved = resolvePersonaTagBinding(binding)
  if (!resolved) return false
  const characterTagSet = new Set(characterTags.map(normalizeTag).filter(Boolean))
  if (characterTagSet.size === 0) return false
  return resolved.mode === 'all'
    ? resolved.tags.every((tag) => characterTagSet.has(normalizeTag(tag)))
    : resolved.tags.some((tag) => characterTagSet.has(normalizeTag(tag)))
}

export function getMatchingPersonaTagBindingIds(
  personas: Persona[],
  personaTagBindings: Record<string, PersonaTagBinding>,
  characterTags: string[],
): string[] {
  const personaIds = new Set(personas.map((persona) => persona.id))
  return Object.entries(personaTagBindings)
    .filter(([personaId, binding]) => personaIds.has(personaId) && characterMatchesPersonaTagBinding(characterTags, binding))
    .map(([personaId]) => personaId)
}

export function resolveAutoPersonaBinding(params: {
  characterId?: string | null
  characterTags?: string[]
  personas: Persona[]
  characterPersonaBindings: Record<string, string | CharacterPersonaBinding>
  personaTagBindings: Record<string, PersonaTagBinding>
}): ResolvedPersonaBinding {
  const { characterId, characterTags = [], personas, characterPersonaBindings, personaTagBindings } = params
  const personaIds = new Set(personas.map((persona) => persona.id))
  const rawCharacterBinding = characterId ? characterPersonaBindings[characterId] : undefined

  if (rawCharacterBinding) {
    const binding = resolveBinding(rawCharacterBinding)
    if (personaIds.has(binding.personaId)) {
      return {
        personaId: binding.personaId,
        source: 'character',
        ambiguous: false,
        addonStates: binding.addonStates,
        matchedPersonaIds: [binding.personaId],
      }
    }
  }

  const matchedPersonaIds = getMatchingPersonaTagBindingIds(personas, personaTagBindings, characterTags)
  if (matchedPersonaIds.length === 1) {
    const binding = resolvePersonaTagBinding(personaTagBindings[matchedPersonaIds[0]])
    return {
      personaId: matchedPersonaIds[0],
      source: 'tag',
      ambiguous: false,
      addonStates: binding?.addonStates,
      matchedPersonaIds,
    }
  }

  return {
    personaId: null,
    source: matchedPersonaIds.length > 1 ? 'tag' : 'none',
    ambiguous: matchedPersonaIds.length > 1,
    matchedPersonaIds,
  }
}

export const createPersonasSlice: StateCreator<PersonasSlice> = (set, get) => ({
  personas: [],
  activePersonaId: null,
  characterPersonaBindings: {},
  personaTagBindings: {},
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
  setPersonaTagBinding: (personaId, binding) => {
    const bindings = { ...get().personaTagBindings }
    const resolved = resolvePersonaTagBinding(binding)
    if (resolved) {
      bindings[personaId] = resolved
    } else {
      delete bindings[personaId]
    }
    set({ personaTagBindings: bindings })
    settingsApi.put('personaTagBindings', bindings).catch(() => {})
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
      const characterBindings = { ...s.characterPersonaBindings }
      let characterBindingsChanged = false
      for (const [charId, val] of Object.entries(characterBindings)) {
        if (resolveBinding(val).personaId === id) {
          delete characterBindings[charId]
          characterBindingsChanged = true
        }
      }

      const personaTagBindings = { ...s.personaTagBindings }
      const tagBindingsChanged = id in personaTagBindings
      if (tagBindingsChanged) {
        delete personaTagBindings[id]
      }

      if (characterBindingsChanged) {
        settingsApi.put('characterPersonaBindings', characterBindings).catch(() => {})
      }
      if (tagBindingsChanged) {
        settingsApi.put('personaTagBindings', personaTagBindings).catch(() => {})
      }

      return {
        personas,
        selectedPersonaId,
        activePersonaId,
        ...(characterBindingsChanged ? { characterPersonaBindings: characterBindings } : {}),
        ...(tagBindingsChanged ? { personaTagBindings } : {}),
      }
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
