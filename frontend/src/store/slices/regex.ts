import type { StateCreator } from 'zustand'
import type { RegexSlice } from '@/types/store'
import { regexApi } from '@/api/regex'
import type { RegexScript, CreateRegexScriptInput, UpdateRegexScriptInput } from '@/types/regex'

export const createRegexSlice: StateCreator<RegexSlice> = (set, get) => ({
  regexScripts: [],
  regexEditingId: null,

  loadRegexScripts: async () => {
    const res = await regexApi.list({ limit: 1000 })
    set({ regexScripts: res.data })
  },

  addRegexScript: async (input: CreateRegexScriptInput) => {
    const script = await regexApi.create(input)
    set((s) => ({ regexScripts: [...s.regexScripts, script] }))
    return script
  },

  updateRegexScript: async (id: string, updates: UpdateRegexScriptInput) => {
    const updated = await regexApi.update(id, updates)
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

  reorderRegexScripts: async (fromIdx: number, toIdx: number) => {
    const scripts = [...get().regexScripts]
    const [moved] = scripts.splice(fromIdx, 1)
    scripts.splice(toIdx, 0, moved)
    // Update local state immediately
    set({ regexScripts: scripts })
    // Persist new order
    await regexApi.reorder(scripts.map((s) => s.id))
  },

  toggleRegexScript: async (id: string, disabled: boolean) => {
    const updated = await regexApi.toggle(id, disabled)
    set((s) => ({
      regexScripts: s.regexScripts.map((r) => (r.id === id ? updated : r)),
    }))
  },

  setRegexEditingId: (id: string | null) => set({ regexEditingId: id }),
})
