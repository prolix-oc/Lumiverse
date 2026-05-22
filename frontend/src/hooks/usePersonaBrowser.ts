import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import Fuse from 'fuse.js'
import { personasApi } from '@/api/personas'
import { imagesApi } from '@/api/images'
import { useStore } from '@/store'
import { toast } from '@/lib/toast'
import type { Persona, CreatePersonaInput, UpdatePersonaInput } from '@/types/api'

const SEARCH_DEBOUNCE_MS = 150

export function usePersonaBrowser() {
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
  const setActivePersona = useStore((s) => s.setActivePersona)
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
      const result = await personasApi.list({ limit: 200 })
      setPersonas(result.data)
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
          cmp = (b.created_at || 0) - (a.created_at || 0)
          break
      }
      return sortDirection === 'desc' ? -cmp : cmp
    })

    return result
  }, [personas, filterType, debouncedQuery, fuse, sortField, sortDirection])

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1)
  }, [filterType, debouncedQuery, sortField, sortDirection])

  // Paginate filtered results
  const totalPages = Math.max(1, Math.ceil(filteredPersonas.length / personasPerPage))
  const safePage = Math.min(currentPage, totalPages)
  const paginatedPersonas = useMemo(() => {
    const start = (safePage - 1) * personasPerPage
    return filteredPersonas.slice(start, start + personasPerPage)
  }, [filteredPersonas, safePage, personasPerPage])

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
      // Upload original (full) version if provided
      let originalImageId: string | undefined
      if (originalFile) {
        const img = await imagesApi.upload(originalFile)
        originalImageId = img.id
      }

      // Upload cropped as avatar — backend cleans up old images (including old original)
      let updated = await personasApi.uploadAvatar(id, croppedFile)

      // Store original_image_id in metadata if we uploaded an original
      if (originalImageId) {
        updated = await personasApi.update(id, {
          metadata: { ...updated.metadata, original_image_id: originalImageId },
        })
      }

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
    },
    [personas, updatePersonaInStore]
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
      const deactivating = activePersonaId === id
      setActivePersona(deactivating ? null : id)
      if (deactivating) {
        toast.info('Persona deactivated')
      } else {
        const persona = personas.find((p) => p.id === id)
        if (persona) {
          toast.info(`Switched to persona: ${persona.name}`)
        }
      }
    },
    [activePersonaId, setActivePersona, personas]
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const result = await personasApi.list({ limit: 200 })
      setPersonas(result.data)
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
    duplicatePersona,
    uploadAvatar,
    toggleDefault,
    setLorebook,
    switchToPersona,
    refresh,
  }
}
