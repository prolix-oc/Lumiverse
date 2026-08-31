import type { StateCreator } from 'zustand'
import type { RegexSlice } from '@/types/store'
import { regexApi } from '@/api/regex'
import type { RegexScript, CreateRegexScriptInput, UpdateRegexScriptInput } from '@/types/regex'
import { enqueuePresetRegexOperation } from '@/lib/presetRegexQueue'
import { applyPresetAuthorityResult, presetSaveCoordinator } from '@/lib/loom/preset-save-coordinator'

// The server caps list responses at 1000 rows, so the slice pages to
// exhaustion. This list drives both the regex panel and the client-side
// display pipeline — a truncated page would silently hide scripts (module
// regexes imported from cards stop applying once a user crosses 1000 total).
const REGEX_LIST_PAGE_SIZE = 1000


export const createRegexSlice: StateCreator<RegexSlice> = (set, get) => ({
  regexScripts: [],
  regexEditingId: null,

  loadRegexScripts: async (shouldApply = () => true) => {
    const scripts: RegexScript[] = []
    let offset = 0
    for (;;) {
      const page = await regexApi.list({ limit: REGEX_LIST_PAGE_SIZE, offset })
      scripts.push(...page.data)
      offset += page.data.length
      if (page.data.length === 0 || offset >= page.total) break
    }
    if (shouldApply()) set({ regexScripts: scripts })
  },

  /** Pure setter for hydrating from pre-fetched data (bootstrap payload). */
  setRegexScripts: (scripts: RegexScript[]) => set({ regexScripts: scripts }),

  addRegexScript: async (input: CreateRegexScriptInput) => {
    const activePresetId = (get() as any).activeLoomPresetId ?? null
    const requestScripts = get().regexScripts
    const scopeEpoch = presetSaveCoordinator.getScopeEpoch()
    const response = await regexApi.create({
      ...input,
      active_preset_id: activePresetId,
    })
    applyPresetAuthorityResult(response, scopeEpoch)
    const script = response.script
    if (get().regexScripts === requestScripts) {
      set({ regexScripts: [...requestScripts, script] })
    }
    return script
  },

  updateRegexScript: async (id: string, updates: UpdateRegexScriptInput) => {
    const activePresetId = (get() as any).activeLoomPresetId ?? null
    const requestScripts = get().regexScripts
    const scopeEpoch = presetSaveCoordinator.getScopeEpoch()
    const response = await regexApi.update(id, {
      ...updates,
      active_preset_id: activePresetId,
    })
    applyPresetAuthorityResult(response, scopeEpoch)
    const updated = response.script
    if (get().regexScripts === requestScripts) {
      set({ regexScripts: requestScripts.map((script) => (script.id === id ? updated : script)) })
    }
  },

  removeRegexScript: async (id: string) => {
    const requestScripts = get().regexScripts
    const scopeEpoch = presetSaveCoordinator.getScopeEpoch()
    const response = await regexApi.remove(id)
    applyPresetAuthorityResult(response, scopeEpoch)
    if (get().regexScripts === requestScripts) {
      set({ regexScripts: requestScripts.filter((script) => script.id !== id) })
    }
  },

  bulkRemoveRegexScripts: async (ids: string[]) => {
    if (ids.length === 0) return 0
    const requestScripts = get().regexScripts
    const scopeEpoch = presetSaveCoordinator.getScopeEpoch()
    const response = await regexApi.bulkRemove(ids)
    applyPresetAuthorityResult(response, scopeEpoch)
    const removed = new Set(response.deleted)
    if (get().regexScripts === requestScripts) {
      set({ regexScripts: requestScripts.filter((script) => !removed.has(script.id)) })
    }
    return response.deleted.length
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
    const scopeEpoch = presetSaveCoordinator.getScopeEpoch()
    const previous = get().regexScripts
    const byId = new Map(previous.map((script) => [script.id, script]))
    const reordered: RegexScript[] = []
    for (const id of orderedIds) {
      const script = byId.get(id)
      if (!script) continue
      byId.delete(id)
      reordered.push(folderChange && script.id === folderChange.id ? { ...script, folder: folderChange.folder } : script)
    }
    for (const script of byId.values()) reordered.push(script)
    set({ regexScripts: reordered })
    const optimisticScripts = get().regexScripts

    try {
      const reorderResult = await regexApi.reorder(orderedIds)
      applyPresetAuthorityResult(reorderResult, scopeEpoch)
      if (folderChange) {
        const response = await regexApi.update(folderChange.id, {
          folder: folderChange.folder,
          active_preset_id: activePresetId,
        })
        applyPresetAuthorityResult(response, scopeEpoch)
        const updated = response.script
        if (get().regexScripts === optimisticScripts) {
          set({ regexScripts: optimisticScripts.map((script) => (script.id === updated.id ? updated : script)) })
        }
      }
    } catch (err) {
      if (get().regexScripts === optimisticScripts) set({ regexScripts: previous })
      throw err
    }
  },

  toggleRegexScript: async (id: string, disabled: boolean) => {
    const activePresetId = (get() as any).activeLoomPresetId ?? null
    const requestScripts = get().regexScripts
    const scopeEpoch = presetSaveCoordinator.getScopeEpoch()
    const response = await enqueuePresetRegexOperation(() => regexApi.toggle(id, disabled, activePresetId))
    applyPresetAuthorityResult(response, scopeEpoch)
    const updated = response.script
    if (get().regexScripts === requestScripts) {
      set({ regexScripts: requestScripts.map((script) => (script.id === id ? updated : script)) })
    }
  },

  toggleSelectedRegexScripts: async (ids: string[], disabled: boolean) => {
    if (ids.length === 0) return { changedIds: [], skippedIds: [] }
    const activePresetId = (get() as any).activeLoomPresetId ?? null
    const requestScripts = get().regexScripts
    const scopeEpoch = presetSaveCoordinator.getScopeEpoch()
    const result = await enqueuePresetRegexOperation(() => regexApi.toggleSelected(ids, disabled, activePresetId))
    applyPresetAuthorityResult(result, scopeEpoch)
    const changed = new Set(result.changedIds)
    if (get().regexScripts === requestScripts) {
      set({ regexScripts: requestScripts.map((script) => (changed.has(script.id) ? { ...script, disabled } : script)) })
    }
    return result
  },

  toggleRegexFolder: async (folder: string, disabled: boolean) => {
    const activePresetId = (get() as any).activeLoomPresetId ?? null
    const requestScripts = get().regexScripts
    const scopeEpoch = presetSaveCoordinator.getScopeEpoch()
    const result = await enqueuePresetRegexOperation(() => regexApi.toggleFolder(folder, disabled, activePresetId))
    applyPresetAuthorityResult(result, scopeEpoch)
    const changed = new Set(result.changedIds)
    if (get().regexScripts === requestScripts) {
      set({ regexScripts: requestScripts.map((script) => (changed.has(script.id) ? { ...script, disabled } : script)) })
    }
    return result
  },

  setRegexEditingId: (id: string | null) => set({ regexEditingId: id }),
})
