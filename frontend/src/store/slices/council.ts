import type { StateCreator } from 'zustand'
import type { CouncilSlice } from '@/types/store'
import type { CouncilMember, CouncilSettings, CouncilToolsSettings, CouncilToolDefinition } from 'lumiverse-spindle-types'
import { COUNCIL_SETTINGS_DEFAULTS, COUNCIL_TOOLS_DEFAULTS } from 'lumiverse-spindle-types'
import { councilApi } from '@/api/council'
import { spindleApi } from '@/api/spindle'
import { generateUUID } from '@/lib/uuid'

let saveTimer: ReturnType<typeof setTimeout> | null = null

function debouncedSave(settings: CouncilSettings) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    councilApi.putSettings(settings).catch((err) => {
      console.error('[council] Failed to save settings:', err)
    })
  }, 500)
}

export const createCouncilSlice: StateCreator<CouncilSlice> = (set, get) => ({
  councilSettings: { ...COUNCIL_SETTINGS_DEFAULTS },
  councilToolResults: [],
  councilExecutionResult: null,
  availableCouncilTools: [],
  councilLoading: false,
  councilExecuting: false,

  setCouncilSettings: (settings) => set({ councilSettings: settings }),
  setCouncilToolResults: (results) => set({ councilToolResults: results }),
  setCouncilExecutionResult: (result) => set({ councilExecutionResult: result }),
  setAvailableCouncilTools: (tools) => set({ availableCouncilTools: tools }),
  setCouncilLoading: (loading) => set({ councilLoading: loading }),
  setCouncilExecuting: (executing) => set({ councilExecuting: executing }),

  loadCouncilSettings: async () => {
    set({ councilLoading: true })
    try {
      const settings = await councilApi.getSettings()
      const storedTools = settings.toolsSettings ?? {}
      set({
        councilSettings: {
          ...COUNCIL_SETTINGS_DEFAULTS,
          ...settings,
          toolsSettings: {
            ...COUNCIL_TOOLS_DEFAULTS,
            ...storedTools,
          },
        },
      })
    } catch (err) {
      console.error('[council] Failed to load settings:', err)
    } finally {
      set({ councilLoading: false })
    }
  },

  saveCouncilSettings: async (partial) => {
    const current = get().councilSettings
    const merged: CouncilSettings = {
      ...current,
      ...partial,
      toolsSettings: partial.toolsSettings
        ? {
            ...current.toolsSettings,
            ...partial.toolsSettings,
          }
        : current.toolsSettings,
    }
    set({ councilSettings: merged })
    debouncedSave(merged)
  },

  loadAvailableTools: async () => {
    try {
      // Fetch council tools (built-in + DLC + any extension tools the backend already merged)
      // AND spindle extension tools separately, then merge so extension tools always appear.
      // Also fetch extension list to resolve display names for grouping.
      const [councilTools, spindleTools, extensionList] = await Promise.all([
        councilApi.getTools(),
        spindleApi.getTools().catch(() => []),
        spindleApi.list().catch(() => ({ extensions: [], isPrivileged: false })),
      ])

      // Build extension_id → display name lookup
      const extNameMap = new Map<string, string>()
      for (const ext of extensionList.extensions) {
        extNameMap.set(ext.id, ext.name)
      }

      // Convert spindle ToolRegistrations → CouncilToolDefinition and merge.
      // Use qualified name (extension_id:name) as key to match the council API format.
      const merged = new Map<string, CouncilToolDefinition>()
      for (const reg of spindleTools) {
        const qualifiedName = `${reg.extension_id}:${reg.name}`
        merged.set(qualifiedName, {
          name: qualifiedName,
          displayName: reg.display_name,
          description: reg.description,
          category: 'extension',
          prompt: reg.description,
          inputSchema: reg.parameters,
          storeInDeliberation: true,
          extensionName: extNameMap.get(reg.extension_id) || reg.extension_id,
        })
      }
      // Council tools (built-in + DLC) overwrite extension tools on name collision
      for (const tool of councilTools) {
        merged.set(tool.name, tool)
      }

      set({ availableCouncilTools: Array.from(merged.values()) })
    } catch (err) {
      console.error('[council] Failed to load tools:', err)
    }
  },

  addCouncilMember: (member: CouncilMember) => {
    const settings = { ...get().councilSettings }
    settings.members = [...settings.members, member]
    set({ councilSettings: settings })
    debouncedSave(settings)
  },

  addCouncilMembersFromPack: (packId: string): number => {
    const state = get() as any
    const packData = state.packsWithItems?.[packId]
    if (!packData?.lumia_items) return 0

    const settings = { ...state.councilSettings }
    const existingSet = new Set(settings.members.map((m: CouncilMember) => `${m.packId}:${m.itemId}`))

    const newMembers: CouncilMember[] = []
    for (const item of packData.lumia_items) {
      if (!item.definition) continue
      if (existingSet.has(`${packId}:${item.id}`)) continue
      newMembers.push({
        id: generateUUID(),
        packId,
        packName: packData.name,
        itemId: item.id,
        itemName: item.name,
        tools: [],
        role: '',
        chance: 100,
      })
    }

    if (newMembers.length === 0) return 0
    settings.members = [...settings.members, ...newMembers]
    set({ councilSettings: settings })
    debouncedSave(settings)
    return newMembers.length
  },

  updateCouncilMember: (id: string, updates: Partial<CouncilMember>) => {
    const settings = { ...get().councilSettings }
    settings.members = settings.members.map((m) =>
      m.id === id ? { ...m, ...updates } : m
    )
    set({ councilSettings: settings })
    debouncedSave(settings)
  },

  removeCouncilMember: (id: string) => {
    const settings = { ...get().councilSettings }
    settings.members = settings.members.filter((m) => m.id !== id)
    set({ councilSettings: settings })
    debouncedSave(settings)
  },

  setCouncilToolsSettings: (partial: Partial<CouncilToolsSettings>) => {
    const settings = { ...get().councilSettings }
    settings.toolsSettings = {
      ...settings.toolsSettings,
      ...partial,
    }
    set({ councilSettings: settings })
    debouncedSave(settings)
  },
})
