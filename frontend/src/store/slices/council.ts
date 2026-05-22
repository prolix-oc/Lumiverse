import type { StateCreator } from 'zustand'
import type { CouncilPersistenceTarget, CouncilSlice } from '@/types/store'
import type { CouncilMember, CouncilSettings, CouncilToolsSettings, CouncilToolDefinition, ExtensionInfo, ToolRegistration } from 'lumiverse-spindle-types'
import { COUNCIL_SETTINGS_DEFAULTS, COUNCIL_TOOLS_DEFAULTS } from 'lumiverse-spindle-types'
import { councilApi } from '@/api/council'
import { spindleApi } from '@/api/spindle'
import { generateUUID } from '@/lib/uuid'

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()

function targetKey(target: CouncilPersistenceTarget): string {
  switch (target.type) {
    case 'chat':
      return `chat:${target.chatId ?? ''}`
    case 'character':
      return `character:${target.characterId ?? ''}`
    case 'defaults':
      return 'defaults'
    case 'global':
    default:
      return 'global'
  }
}

async function persistCouncilSettings(settings: CouncilSettings, target: CouncilPersistenceTarget) {
  switch (target.type) {
    case 'defaults':
      await councilApi.putDefaults({ council_settings: settings })
      return
    case 'character':
      if (!target.characterId) return
      await councilApi.putCharacterBinding(target.characterId, { council_settings: settings })
      return
    case 'chat':
      if (!target.chatId) return
      await councilApi.putChatBinding(target.chatId, { council_settings: settings })
      return
    case 'global':
    default:
      await councilApi.putSettings(settings)
  }
}

/** Merge rules shared between network refresh (`loadAvailableTools`) and
 *  bootstrap hydration (`hydrateCouncilTools`). Spindle extension tools are
 *  converted to CouncilToolDefinition shape first; built-in / DLC tools
 *  from the backend overwrite them on name collision. */
function mergeCouncilAndSpindleTools(
  councilTools: CouncilToolDefinition[],
  spindleTools: ToolRegistration[],
  extensions: Array<{ id: string; name: string }>,
): CouncilToolDefinition[] {
  const extNameMap = new Map<string, string>()
  for (const ext of extensions) extNameMap.set(ext.id, ext.name)

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
  return Array.from(merged.values())
}

function debouncedSave(settings: CouncilSettings, target: CouncilPersistenceTarget) {
  const key = targetKey(target)
  const existingTimer = saveTimers.get(key)
  if (existingTimer) clearTimeout(existingTimer)
  const timer = setTimeout(() => {
    saveTimers.delete(key)
    persistCouncilSettings(settings, target).catch((err) => {
      console.error('[council] Failed to save settings:', err)
    })
  }, 500)
  saveTimers.set(key, timer)
}

export const createCouncilSlice: StateCreator<CouncilSlice> = (set, get) => ({
  councilSettings: { ...COUNCIL_SETTINGS_DEFAULTS },
  councilPersistenceTarget: { type: 'global' },
  councilToolResults: [],
  councilExecutionResult: null,
  availableCouncilTools: [],
  councilLoading: false,
  councilExecuting: false,
  councilToolsFailure: null,

  setCouncilSettings: (settings) => set({ councilSettings: settings }),
  setCouncilPersistenceTarget: (target) => set({ councilPersistenceTarget: target }),
  setCouncilToolResults: (results) => set({ councilToolResults: results }),
  setCouncilExecutionResult: (result) => set({ councilExecutionResult: result }),
  setAvailableCouncilTools: (tools) => set({ availableCouncilTools: tools }),
  setCouncilLoading: (loading) => set({ councilLoading: loading }),
  setCouncilExecuting: (executing) => set({ councilExecuting: executing }),
  setCouncilToolsFailure: (failure) => set({ councilToolsFailure: failure }),

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
        councilPersistenceTarget: { type: 'global' },
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
    debouncedSave(merged, get().councilPersistenceTarget)
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

      const merged = mergeCouncilAndSpindleTools(councilTools, spindleTools, extensionList.extensions)
      set({ availableCouncilTools: merged })
    } catch (err) {
      console.error('[council] Failed to load tools:', err)
    }
  },

  /** Apply council tools from an external source (e.g. the bootstrap payload).
   *  Uses the same merge rules as `loadAvailableTools` but skips the three
   *  network round trips — callers supply the already-fetched data. */
  hydrateCouncilTools: (councilTools, spindleTools, extensions) => {
    const merged = mergeCouncilAndSpindleTools(councilTools, spindleTools, extensions)
    set({ availableCouncilTools: merged })
  },

  addCouncilMember: (member: CouncilMember) => {
    const settings = { ...get().councilSettings }
    settings.members = [...settings.members, member]
    set({ councilSettings: settings })
    debouncedSave(settings, get().councilPersistenceTarget)
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
    debouncedSave(settings, state.councilPersistenceTarget)
    return newMembers.length
  },

  updateCouncilMember: (id: string, updates: Partial<CouncilMember>) => {
    const settings = { ...get().councilSettings }
    settings.members = settings.members.map((m) =>
      m.id === id ? { ...m, ...updates } : m
    )
    set({ councilSettings: settings })
    debouncedSave(settings, get().councilPersistenceTarget)
  },

  removeCouncilMember: (id: string) => {
    const settings = { ...get().councilSettings }
    settings.members = settings.members.filter((m) => m.id !== id)
    set({ councilSettings: settings })
    debouncedSave(settings, get().councilPersistenceTarget)
  },

  setCouncilToolsSettings: (partial: Partial<CouncilToolsSettings>) => {
    const settings = { ...get().councilSettings }
    settings.toolsSettings = {
      ...settings.toolsSettings,
      ...partial,
    }
    set({ councilSettings: settings })
    debouncedSave(settings, get().councilPersistenceTarget)
  },
})
