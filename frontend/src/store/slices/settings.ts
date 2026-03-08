import type { StateCreator } from 'zustand'
import type { SettingsSlice, ThemeConfig } from '@/types/store'
import { settingsApi } from '@/api/settings'
import { BASE_URL } from '@/api/client'

/** Keys that represent persisted data (not functions) */
const DATA_KEYS: ReadonlySet<string> = new Set([
  'enableLandingPage',
  'landingPageChatsDisplayed',
  'charactersPerPage',
  'personasPerPage',
  'chatSheldDisplayMode',
  'chatSheldEnterToSend',
  'chatWidthMode',
  'chatContentMaxWidth',
  'portraitPanelSide',
  'theme',
  'drawerSettings',
  'oocEnabled',
  'lumiaOOCStyle',
  'lumiaOOCInterval',
  'ircUseLeetHandles',
  'chimeraMode',
  'lumiaQuirks',
  'lumiaQuirksEnabled',
  'sovereignHand',
  'contextFilters',
  'activeProfileId',
  'activePersonaId',
  'activeLoomPresetId',
  // Character browser preferences
  'favorites',
  'viewMode',
  'sortField',
  'sortDirection',
  'filterTab',
  // Persona browser preferences
  'personaViewMode',
  'personaSortField',
  'personaSortDirection',
  'personaFilterType',
  // Pack browser preferences
  'packFilterTab',
  'packSortField',
  // Active Lumia selections
  'selectedDefinition',
  'selectedBehaviors',
  'selectedPersonalities',
  // Image generation settings
  'imageGeneration',
  // Summarization settings
  'summarization',
  // Reasoning / CoT settings
  'reasoningSettings',
  'promptBias',
  'guidedGenerations',
  'quickReplySets',
])

// ── Debounced batch persistence ──────────────────────────────────────────
// Dirty keys accumulate and flush as a single PUT after FLUSH_DELAY ms of
// inactivity.  Also flushes on page unload so nothing is lost.
const FLUSH_DELAY = 1_500
const dirtyKeys = new Map<string, any>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushInFlight = false

function flushDirtyKeys() {
  flushTimer = null
  if (dirtyKeys.size === 0) return

  const batch = Object.fromEntries(dirtyKeys)
  dirtyKeys.clear()
  flushInFlight = true

  settingsApi.putMany(batch).catch((err) => {
    console.error('[settings] Batch persist failed, re-queuing:', err)
    // Re-queue failed keys so the next flush retries them
    for (const [k, v] of Object.entries(batch)) {
      if (!dirtyKeys.has(k)) dirtyKeys.set(k, v)
    }
    scheduleFlush()
  }).finally(() => {
    flushInFlight = false
  })
}

function scheduleFlush() {
  if (flushTimer !== null) clearTimeout(flushTimer)
  flushTimer = setTimeout(flushDirtyKeys, FLUSH_DELAY)
}

function persistKey(key: string, value: any) {
  dirtyKeys.set(key, value)
  scheduleFlush()
}

/** Immediately flush any pending settings (e.g. on page unload). */
export function flushSettings() {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (dirtyKeys.size === 0) return

  const batch = Object.fromEntries(dirtyKeys)
  dirtyKeys.clear()

  // keepalive fetch survives page unload and supports PUT (unlike sendBeacon)
  fetch(`${BASE_URL}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(batch),
    keepalive: true,
  }).catch(() => {})
}

/** True when a flush is in flight or dirty keys are pending. */
export function hasUnsavedSettings(): boolean {
  return dirtyKeys.size > 0 || flushInFlight
}

// Flush on page unload so slider drags / rapid changes are never lost
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushSettings)
}

export const createSettingsSlice: StateCreator<SettingsSlice> = (set, get) => ({
  enableLandingPage: true,
  landingPageChatsDisplayed: 12,
  charactersPerPage: 50,
  personasPerPage: 24,
  chatSheldDisplayMode: 'minimal',
  chatSheldEnterToSend: true,
  chatWidthMode: 'full',
  chatContentMaxWidth: 900,
  portraitPanelSide: 'right',
  theme: null,
  drawerSettings: {
    side: 'right',
    verticalPosition: 15,
    tabSize: 'large',
    panelWidthMode: 'default',
    customPanelWidth: 35,
  },
  oocEnabled: true,
  lumiaOOCStyle: 'social',
  lumiaOOCInterval: null,
  ircUseLeetHandles: true,
  chimeraMode: false,
  lumiaQuirks: '',
  lumiaQuirksEnabled: true,
  sovereignHand: {
    enabled: false,
    excludeLastMessage: true,
    includeMessageInPrompt: true,
  },
  contextFilters: {
    htmlTags: { enabled: false, keepDepth: 3, stripFonts: false, fontKeepDepth: 3 },
    detailsBlocks: { enabled: false, keepDepth: 3 },
    loomItems: { enabled: false, keepDepth: 5 },
  },
  reasoningSettings: {
    prefix: '<think>\n',
    suffix: '\n</think>',
    autoParse: true,
    apiReasoning: false,
    reasoningEffort: 'auto',
    keepInHistory: 0,
  },
  promptBias: '',
  guidedGenerations: [],
  quickReplySets: [],

  setSetting: (key, value) => {
    set({ [key]: value } as any)
    if (DATA_KEYS.has(key as string)) {
      persistKey(key as string, value)
    }
  },

  setTheme: (theme) => {
    set({ theme })
    persistKey('theme', theme)
  },

  loadSettings: async () => {
    try {
      const rows = await settingsApi.getAll()
      const patch: Record<string, any> = {}
      for (const row of rows) {
        if (DATA_KEYS.has(row.key)) {
          patch[row.key] = row.value
        }
      }
      // Migration: discard old ThemeConfig shape (has baseColors but no accent)
      if (patch.theme && 'baseColors' in patch.theme && !('accent' in patch.theme)) {
        patch.theme = null
      }
      if (Object.keys(patch).length > 0) {
        set(patch as any)
      }
    } catch (err) {
      console.error('[settings] Failed to load settings:', err)
    }
  },
})
