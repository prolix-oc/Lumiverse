import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import Fuse from 'fuse.js'
import { personasApi } from '@/api/personas'
import { chatsApi } from '@/api/chats'
import { useStore } from '@/store'
import { personaToastName, resolveAutoPersonaBinding } from '@/store/slices/personas'
import {
  CHAT_PERSONA_METADATA_KEY,
  getPersistedChatPersonaId,
  resolveChatPersonaSelection,
  setPersistedChatPersonaId,
} from '@/lib/chatPersonaSelection'
import { toast } from '@/lib/toast'
import type { Persona, CreatePersonaInput, UpdatePersonaInput } from '@/types/api'

const SEARCH_DEBOUNCE_MS = 150

export function usePersonaBrowser() {
  const { t } = useTranslation('panels', { keyPrefix: 'personaManager.toast' })
  const [currentPage, setCurrentPage] = useState(1)
  const personasPerPage = useStore((s) => s.personasPerPage)
  const setSetting = useStore((s) => s.setSetting)

  // Store state
  const personas = useStore((s) => s.personas)
  const setPersonas = useStore((s) => s.setPersonas)
  const addPersona = useStore((s) => s.addPersona)
  const updatePersonaInStore = useStore((s) => s.updatePersona)
  const removePersona = useStore((s) => s.removePersona)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const recentPersonaIds = useStore((s) => s.recentPersonaIds)
  const setActivePersona = useStore((s) => s.setActivePersona)
  const activeChatId = useStore((s) => s.activeChatId)
  const activeChatMetadata = useStore((s) => s.activeChatMetadata)
  const setActiveChatMetadata = useStore((s) => s.setActiveChatMetadata)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const characters = useStore((s) => s.characters)
  const characterPersonaBindings = useStore((s) => s.characterPersonaBindings)
  const personaTagBindings = useStore((s) => s.personaTagBindings)
  const searchQuery = useStore((s) => s.personaSearchQuery)
  const setSearchQuery = useStore((s) => s.setPersonaSearchQuery)
  const filterType = useStore((s) => s.personaFilterType)
  const setFilterType = useStore((s) => s.setPersonaFilterType)
  const sortField = useStore((s) => s.personaSortField)
  const setSortField = useStore((s) => s.setPersonaSortField)
  const sortDirection = useStore((s) => s.personaSortDirection)
  const toggleSortDirection = useStore((s) => s.togglePersonaSortDirection)
  const viewMode = useStore((s) => s.personaViewMode)
  const setViewMode = useStore((s) => s.setPersonaViewMode)
  const selectedPersonaId = useStore((s) => s.selectedPersonaId)
  const setSelectedPersonaId = useStore((s) => s.setSelectedPersonaId)

  // Local state
  const [loading, setLoading] = useState(false)
  const [debouncedQuery, setDebouncedQuery] = useState(searchQuery)
  const isChatScoped = !!activeChatId && activeChatMetadata?.temporary !== true
  const persistedChatPersonaId = useMemo(
    () => getPersistedChatPersonaId(activeChatMetadata),
    [activeChatMetadata],
  )

  // Debounced search
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    debounceRef.current = setTimeout(() => setDebouncedQuery(searchQuery), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(debounceRef.current)
  }, [searchQuery])

  // Load personas on mount if empty
  const loadPersonas = useCallback(async () => {
    setLoading(true)
    try {
      setPersonas(await personasApi.listAll())
    } catch (err) {
      console.error('[PersonaBrowser] Failed to load:', err)
    } finally {
      setLoading(false)
    }
  }, [setPersonas])

  useEffect(() => {
    if (personas.length > 0) return
    loadPersonas()
  }, [personas.length, loadPersonas])

  // Fuse.js instance
  //
  // ignoreLocation + minMatchCharLength=2 are required for CJK / Unicode
  // substring search. Fuse's default Bitap scoring anchors matches near
  // `location: 0` and penalises anything further away — which shreds
  // relevance for unspaced scripts (Chinese, Japanese, Korean, Thai) where
  // the entire phrase is one unbroken run. ignoreLocation makes Fuse score
  // by match quality regardless of position; minMatchCharLength: 2 lets
  // short CJK names like 魔王 / 勇者 match without being filtered out.
  const fuse = useMemo(
    () =>
      new Fuse(personas, {
        keys: ['name', 'title', 'description'],
        threshold: 0.3,
        ignoreLocation: true,
        minMatchCharLength: 2,
      }),
    [personas]
  )

  // Filtering pipeline
  const filteredPersonas = useMemo(() => {
    let result = personas

    // 1. Filter by type
    if (filterType === 'default') {
      result = result.filter((p) => p.is_default)
    } else if (filterType === 'connected') {
      result = result.filter((p) => p.attached_world_book_id != null)
    }

    // 2. Search
    if (debouncedQuery.trim()) {
      const searchResults = fuse.search(debouncedQuery)
      const searchIds = new Set(searchResults.map((r) => r.item.id))
      result = result.filter((p) => searchIds.has(p.id))
    }

    // 3. Sort
    result = [...result].sort((a, b) => {
      let cmp = 0
      switch (sortField) {
        case 'name':
          cmp = a.name.localeCompare(b.name)
          break
        case 'created':
          cmp = (a.created_at || 0) - (b.created_at || 0)
          break
        case 'updated_at':
          cmp = (a.updated_at || 0) - (b.updated_at || 0)
          break
      }
      return sortDirection === 'desc' ? -cmp : cmp
    })

    return result
  }, [personas, filterType, debouncedQuery, fuse, sortField, sortDirection])

  const recentPersonas = useMemo(() => {
    const filteredById = new Map(filteredPersonas.map((persona) => [persona.id, persona]))
    return recentPersonaIds
      .map((id) => filteredById.get(id))
      .filter((persona): persona is Persona => !!persona)
  }, [filteredPersonas, recentPersonaIds])

  const recentPersonaIdSet = useMemo(
    () => new Set(recentPersonas.map((persona) => persona.id)),
    [recentPersonas],
  )
  const regularPersonas = useMemo(
    () => filteredPersonas.filter((persona) => !recentPersonaIdSet.has(persona.id)),
    [filteredPersonas, recentPersonaIdSet],
  )

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1)
  }, [filterType, debouncedQuery, sortField, sortDirection])

  // Paginate filtered results
  const totalPages = Math.max(1, Math.ceil(regularPersonas.length / personasPerPage))
  const safePage = Math.min(currentPage, totalPages)
  const paginatedPersonas = useMemo(() => {
    const start = (safePage - 1) * personasPerPage
    return regularPersonas.slice(start, start + personasPerPage)
  }, [regularPersonas, safePage, personasPerPage])

  // Group paginated personas by folder
  const groupedPersonas = useMemo(() => {
    const groups: Array<{ folder: string; personas: Persona[] }> = []
    const folderMap = new Map<string, Persona[]>()
    for (const p of paginatedPersonas) {
      const key = p.folder || ''
      if (!folderMap.has(key)) {
        folderMap.set(key, [])
        groups.push({ folder: key, personas: folderMap.get(key)! })
      }
      folderMap.get(key)!.push(p)
    }
    return groups
  }, [paginatedPersonas])

  // All unique folders for the filter
  const allFolders = useMemo(() => {
    const set = new Set<string>()
    personas.forEach((p) => { if (p.folder) set.add(p.folder) })
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [personas])

  const setPersonasPerPage = useCallback(
    (perPage: number) => {
      setSetting('personasPerPage', perPage)
      setCurrentPage(1)
    },
    [setSetting]
  )

  // CRUD operations
  const createPersona = useCallback(
    async (input: CreatePersonaInput) => {
      const persona = await personasApi.create(input)
      addPersona(persona)
      return persona
    },
    [addPersona]
  )

  const updatePersona = useCallback(
    async (id: string, input: UpdatePersonaInput) => {
      const persona = await personasApi.update(id, input)
      updatePersonaInStore(id, persona)
      return persona
    },
    [updatePersonaInStore]
  )

  const renameFolder = useCallback(
    async (oldName: string, newName: string) => {
      const result = await personasApi.renameFolder(oldName, newName)
      if (result.updated.length === 0) return result

      const updatedById = new Map(result.updated.map((persona) => [persona.id, persona]))
      const currentPersonas = useStore.getState().personas
      setPersonas(currentPersonas.map((persona) => updatedById.get(persona.id) ?? persona))
      return result
    },
    [setPersonas]
  )

  const deleteFolder = useCallback(
    async (name: string) => {
      const result = await personasApi.deleteFolder(name)
      if (result.updated.length === 0) return result

      const updatedById = new Map(result.updated.map((persona) => [persona.id, persona]))
      const currentPersonas = useStore.getState().personas
      setPersonas(currentPersonas.map((persona) => updatedById.get(persona.id) ?? persona))
      return result
    },
    [setPersonas]
  )

  const deletePersona = useCallback(
    async (id: string) => {
      await personasApi.delete(id)
      removePersona(id)
    },
    [removePersona]
  )

  const bulkUpdatePersonas = useCallback(
    async (ids: string[], input: {
      folder?: string
      attached_world_book_id?: string | null
      toggle_narrator?: boolean
    }) => {
      const result = await personasApi.bulkUpdate(ids, input)
      if (result.updated.length > 0) {
        const updatedById = new Map(result.updated.map((persona) => [persona.id, persona]))
        const currentPersonas = useStore.getState().personas
        setPersonas(currentPersonas.map((persona) => updatedById.get(persona.id) ?? persona))
      }
      return result
    },
    [setPersonas],
  )

  const bulkDeletePersonas = useCallback(
    async (ids: string[]) => {
      const result = await personasApi.bulkDelete(ids)
      for (const id of result.deleted) removePersona(id)
      return result
    },
    [removePersona],
  )

  const duplicatePersona = useCallback(
    async (id: string) => {
      const persona = await personasApi.duplicate(id)
      addPersona(persona)
      return persona
    },
    [addPersona]
  )

  const uploadAvatar = useCallback(
    async (id: string, croppedFile: File, originalFile?: File) => {
      const updated = await personasApi.uploadAvatar(id, croppedFile, originalFile)
      updatePersonaInStore(id, updated)
      return updated
    },
    [updatePersonaInStore]
  )

  const toggleDefault = useCallback(
    async (id: string) => {
      const persona = personas.find((p) => p.id === id)
      if (!persona) return
      const newDefault = !persona.is_default
      const updated = await personasApi.update(id, { is_default: newDefault })
      // If setting as default, clear previous default in local state
      if (newDefault) {
        const prev = personas.find((p) => p.is_default && p.id !== id)
        if (prev) {
          updatePersonaInStore(prev.id, { ...prev, is_default: false })
        }
      }
      updatePersonaInStore(id, updated)

      // Promote the new default into the active slot when nothing else is
      // claiming it: no active persona, or no character/tag binding is
      // already overriding the current chat. If a binding exists, leave the
      // bound persona in place so the user's contextual choice wins.
      if (newDefault && activePersonaId !== id) {
        const state = useStore.getState()
        const character = state.activeCharacterId
          ? state.characters.find((c) => c.id === state.activeCharacterId)
          : null
        const resolved = resolveAutoPersonaBinding({
          characterId: state.activeCharacterId,
          characterTags: character?.tags ?? [],
          personas: state.personas,
          characterPersonaBindings: state.characterPersonaBindings,
          personaTagBindings: state.personaTagBindings,
        })
        if (!resolved.personaId) {
          setActivePersona(id)
          toast.info(t('switchedToPersona', { name: personaToastName(updated) }))
        }
      }
    },
    [personas, updatePersonaInStore, activePersonaId, setActivePersona, t]
  )

  const setLorebook = useCallback(
    async (id: string, worldBookId: string | null) => {
      const updated = await personasApi.update(id, {
        // Pass value directly so null is sent to the backend for detachment
        attached_world_book_id: worldBookId,
      })
      updatePersonaInStore(id, updated)
    },
    [updatePersonaInStore]
  )

  const switchToPersona = useCallback(
    (id: string) => {
      const deactivating = isChatScoped ? persistedChatPersonaId === id : activePersonaId === id

      if (!isChatScoped) {
        setActivePersona(deactivating ? null : id)
        if (deactivating) {
          toast.info(t('personaDeactivated'))
        } else {
          const persona = personas.find((p) => p.id === id)
          if (persona) {
            toast.info(t('switchedToPersona', { name: personaToastName(persona) }))
          }
        }
        return
      }

      const activeCharacter = activeCharacterId
        ? characters.find((character) => character.id === activeCharacterId) ?? null
        : null
      const nextPersonaId = deactivating ? null : id
      const previousMetadata = activeChatMetadata
      const previousActivePersonaId = activePersonaId
      const nextMetadata = setPersistedChatPersonaId(previousMetadata, nextPersonaId)
      const fallbackPersonaId = nextPersonaId ?? resolveChatPersonaSelection({
        metadata: nextMetadata,
        characterId: activeCharacterId,
        characterTags: activeCharacter?.tags ?? [],
        personas,
        characterPersonaBindings,
        personaTagBindings,
      }).personaId

      setActiveChatMetadata(nextMetadata)
      setActivePersona(fallbackPersonaId)

      chatsApi.patchMetadata(activeChatId, { [CHAT_PERSONA_METADATA_KEY]: nextPersonaId }).then(() => {
        if (deactivating) {
          toast.info(t('personaDeactivated'))
          return
        }
        const persona = personas.find((p) => p.id === id)
        if (persona) {
          toast.info(t('switchedToPersona', { name: personaToastName(persona) }))
        }
      }).catch((err) => {
        console.error('[PersonaBrowser] Failed to save chat persona selection:', err)
        setActiveChatMetadata(previousMetadata)
        setActivePersona(previousActivePersonaId)
        toast.error(t('failedSaveChatPersona'))
      })
    },
    [
      activeChatId,
      activeChatMetadata,
      activeCharacterId,
      activePersonaId,
      characters,
      characterPersonaBindings,
      personaTagBindings,
      persistedChatPersonaId,
      personas,
      setActiveChatMetadata,
      setActivePersona,
      t,
    ]
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setPersonas(await personasApi.listAll())
    } catch (err) {
      console.error('[PersonaBrowser] Failed to refresh:', err)
    } finally {
      setLoading(false)
    }
  }, [setPersonas])

  return {
    // State
    personas: paginatedPersonas,
    groupedPersonas,
    recentPersonas: safePage === 1 ? recentPersonas : [],
    allFilteredPersonas: filteredPersonas,
    allPersonas: personas,
    allFolders,
    totalFiltered: filteredPersonas.length,
    loading,
    searchQuery,
    filterType,
    sortField,
    sortDirection,
    viewMode,
    selectedPersonaId,
    activePersonaId,
    isChatScoped,
    persistedChatPersonaId,
    currentPage: safePage,
    totalPages,
    personasPerPage,

    // Actions
    setCurrentPage,
    setPersonasPerPage,
    setSearchQuery,
    setFilterType,
    setSortField,
    toggleSortDirection,
    setViewMode,
    setSelectedPersonaId,
    createPersona,
    updatePersona,
    renameFolder,
    deleteFolder,
    deletePersona,
    bulkUpdatePersonas,
    bulkDeletePersonas,
    duplicatePersona,
    uploadAvatar,
    toggleDefault,
    setLorebook,
    switchToPersona,
    refresh,
  }
}
