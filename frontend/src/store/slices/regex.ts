import type { StateCreator } from 'zustand'
import type { RegexSlice } from '@/types/store'
import { regexApi } from '@/api/regex'
import type { RegexScript, CreateRegexScriptInput, UpdateRegexScriptInput } from '@/types/regex'
import { enqueuePresetRegexOperation } from '@/lib/presetRegexQueue'

export const createRegexSlice: StateCreator<RegexSlice> = (set, get) => ({
  regexScripts: [],
  regexEditingId: null,

  loadRegexScripts: async () => {
    const res = await regexApi.list({ limit: 1000 })
    set({ regexScripts: res.data })
  },

  /** Pure setter for hydrating from pre-fetched data (bootstrap payload). */
  setRegexScripts: (scripts: RegexScript[]) => set({ regexScripts: scripts }),

  addRegexScript: async (input: CreateRegexScriptInput) => {
    const activePresetId = (get() as any).activeLoomPresetId ?? null
    const script = await regexApi.create({
      ...input,
      active_preset_id: activePresetId,
    })
    set((s) => ({ regexScripts: [...s.regexScripts, script] }))
    return script
  },

  updateRegexScript: async (id: string, updates: UpdateRegexScriptInput) => {
    const activePresetId = (get() as any).activeLoomPresetId ?? null
    const updated = await regexApi.update(id, {
      ...updates,
      active_preset_id: activePresetId,
    })
    set((s) => ({
      regexScripts: s.regexScripts.map((r) => (r.id === id ? updated : r)),
    }))
  },

  removeRegexScript: async (id: string) => {
    await regexApi.remove(id)
    set((s) => ({
      regexScripts: s.regexScripts.filter((r) => r.id !== id),
    }))
  },

  bulkRemoveRegexScripts: async (ids: string[]) => {
    if (ids.length === 0) return 0
    const { deleted } = await regexApi.bulkRemove(ids)
    const removed = new Set(deleted)
    set((s) => ({
      regexScripts: s.regexScripts.filter((r) => !removed.has(r.id)),
    }))
    return deleted.length
  },

  // Drag-to-reorder. `orderedIds` is the full list of script ids in their new
  // order (sort_order is re-stamped 0..n by the backend). `folderChange`, when
  // present, also moves one script into a different folder (cross-folder drag).
  //
  // The reorder write is issued BEFORE the folder write. Only the folder write
  // emits a REGEX_SCRIPT_CHANGED event (reorder is silent), and that event makes
  // every tab refetch the list — so by the time it fires, the new sort_order is
  // already committed and the refetch reads a fully consistent state. Doing it
  // the other way round lets the refetch land between the two writes and clobber
  // the new order with the stale one.
  reorderRegexScripts: async (orderedIds: string[], folderChange?: { id: string; folder: string }) => {
    const activePresetId = (get() as any).activeLoomPresetId ?? null
    const previous = get().regexScripts
    // Optimistic local update: apply the new order + any folder reassignment.
    const byId = new Map(previous.map((r) => [r.id, r]))
    const reordered: RegexScript[] = []
    for (const id of orderedIds) {
      const r = byId.get(id)
      if (!r) continue
      byId.delete(id)
      reordered.push(folderChange && r.id === folderChange.id ? { ...r, folder: folderChange.folder } : r)
    }
    // Defensive: keep any scripts not referenced in orderedIds (shouldn't happen).
    for (const r of byId.values()) reordered.push(r)
    set({ regexScripts: reordered })

    try {
      await regexApi.reorder(orderedIds)
      if (folderChange) {
        const updated = await regexApi.update(folderChange.id, {
          folder: folderChange.folder,
          active_preset_id: activePresetId,
        })
        set((s) => ({ regexScripts: s.regexScripts.map((r) => (r.id === updated.id ? updated : r)) }))
      }
    } catch (err) {
      // Roll back to the pre-drag order on failure.
      set({ regexScripts: previous })
      throw err
    }
  },

  toggleRegexScript: async (id: string, disabled: boolean) => {
    const activePresetId = (get() as any).activeLoomPresetId ?? null
    const updated = await enqueuePresetRegexOperation(() => regexApi.toggle(id, disabled, activePresetId))
    set((s) => ({
      regexScripts: s.regexScripts.map((r) => (r.id === id ? updated : r)),
    }))
  },

  setRegexEditingId: (id: string | null) => set({ regexEditingId: id }),
})
