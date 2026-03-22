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
  'messagesPerPage',
  'chatSheldDisplayMode',
  'bubbleUserAlign',
  'chatSheldEnterToSend',
  'saveDraftInput',
  'chatWidthMode',
  'chatContentMaxWidth',
  'modalWidthMode',
  'modalMaxWidth',
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
  'activeLumiPresetId',
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
  // Character-persona bindings
  'characterPersonaBindings',
  // Pack browser preferences
  'packFilterTab',
  'packSortField',
  // Active Lumia selections
  'selectedDefinition',
  'selectedBehaviors',
  'selectedPersonalities',
  // Active Loom selections
  'selectedLoomStyles',
  'selectedLoomUtils',
  'selectedLoomRetrofits',
  // Global world books (always active regardless of character)
  'globalWorldBooks',
  // World info activation settings (budget, scan depth, recursion)
  'worldInfoSettings',
  // Image generation settings
  'imageGeneration',
  // Summarization settings
  'summarization',
  // Wallpaper settings
  'wallpaper',
  // Reasoning / CoT settings
  'reasoningSettings',
  'promptBias',
  'regenFeedback',
  'guidedGenerations',
  'quickReplySets',
  'toastPosition',
  // Expression display settings
  'expressionDisplay',
  'expressionDetection',
  // Shared sidecar LLM settings
  'sidecarSettings',
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
  messagesPerPage: 50,
  chatSheldDisplayMode: 'minimal',
  bubbleUserAlign: 'right',
  chatSheldEnterToSend: true,
  saveDraftInput: false,
  chatWidthMode: 'full',
  chatContentMaxWidth: 900,
  modalWidthMode: 'full',
  modalMaxWidth: 900,
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
    detailsBlocks: { enabled: false, keepDepth: 3, keepOnly: false },
    loomItems: { enabled: false, keepDepth: 5, keepOnly: false },
  },
  reasoningSettings: {
    prefix: '<think>\n',
    suffix: '\n</think>',
    autoParse: true,
    apiReasoning: false,
    reasoningEffort: 'auto',
    keepInHistory: 0,
  },
  regenFeedback: {
    enabled: false,
    position: 'user',
  },
  globalWorldBooks: [],
  worldInfoSettings: {
    globalScanDepth: null,
    maxRecursionPasses: 3,
    maxActivatedEntries: 0,
    maxTokenBudget: 0,
    minPriority: 0,
  },
  promptBias: '',
  guidedGenerations: [],
  quickReplySets: [],
  toastPosition: 'bottom-right',
  wallpaper: {
    global: null,
    opacity: 0.3,
    fit: 'cover',
  },

  setWallpaper: (partial) =>
    set((state) => {
      const wallpaper = { ...state.wallpaper, ...partial }
      persistKey('wallpaper', wallpaper)
      return { wallpaper }
    }),

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
