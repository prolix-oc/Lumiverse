import type { StateCreator } from 'zustand'
import type { SettingsSlice, ThemeConfig, ReasoningSettings } from '@/types/store'
import { settingsApi } from '@/api/settings'
import { BASE_URL } from '@/api/client'

/** Default reasoning settings — used as initial state and for restore-on-unbind. */
export const REASONING_DEFAULTS: ReasoningSettings = {
  prefix: '<think>\n',
  suffix: '\n</think>',
  autoParse: true,
  apiReasoning: false,
  reasoningEffort: 'auto',
  keepInHistory: 0,
}

/** Keys that represent persisted data (not functions) */
const DATA_KEYS: ReadonlySet<string> = new Set([
  'landingPageChatsDisplayed',
  'charactersPerPage',
  'personasPerPage',
  'messagesPerPage',
  'chatSheldDisplayMode',
  'bubbleUserAlign',
  'bubbleDisableHover',
  'bubbleHideAvatarBg',
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
  'swipeGesturesEnabled',
  'guidedGenerations',
  'quickReplySets',
  'toastPosition',
  // Expression display settings
  'expressionDisplay',
  'expressionDetection',
  // Shared sidecar LLM settings
  'sidecarSettings',
  // Image optimization (thumbnail tier sizes)
  'thumbnailSettings',
  // Push notification preferences
  'pushNotificationPreferences',
  'customCSS',
  'componentOverrides',
  'chatHeadsEnabled',
  'chatHeadsSize',
  'chatHeadsDirection',
  'chatHeadsOpacity',
  'voiceSettings',
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

/** Remove a key from the pending dirty-keys map so the next flush won't overwrite a direct PUT. */
export function clearDirtyKey(key: string): void {
  dirtyKeys.delete(key)
}

// Flush on page unload so slider drags / rapid changes are never lost
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushSettings)
}

export const createSettingsSlice: StateCreator<SettingsSlice> = (set, get) => ({
  landingPageChatsDisplayed: 12,
  charactersPerPage: 50,
  personasPerPage: 24,
  messagesPerPage: 50,
  chatSheldDisplayMode: 'minimal',
  bubbleUserAlign: 'right',
  bubbleDisableHover: false,
  bubbleHideAvatarBg: false,
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
    showTabLabels: false,
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
  reasoningSettings: { ...REASONING_DEFAULTS },
  regenFeedback: {
    enabled: false,
    position: 'user',
  },
  swipeGesturesEnabled: true,
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

  thumbnailSettings: { smallSize: 300, largeSize: 700 },
  pushNotificationPreferences: { enabled: true, events: { generation_ended: true, generation_error: false } },
  chatHeadsEnabled: true,
  chatHeadsSize: 48,
  chatHeadsDirection: 'column' as const,
  chatHeadsOpacity: 1,
  customCSS: { css: '', enabled: false, revision: 0 },
  componentOverrides: {},
  voiceSettings: {
    sttProvider: 'webspeech' as const,
    sttLanguage: 'en-US',
    sttContinuous: false,
    sttInterimResults: true,
    sttConnectionId: null,
    ttsEnabled: false,
    ttsConnectionId: null,
    ttsAutoPlay: false,
    ttsSpeed: 1.0,
    ttsVolume: 0.8,
    speechDetectionRules: {
      asterisked: 'skip' as const,
      quoted: 'speech' as const,
      undecorated: 'narration' as const,
    },
  },

  setVoiceSettings: (partial) =>
    set((state) => {
      const voiceSettings = { ...state.voiceSettings, ...partial }
      if (partial.speechDetectionRules) {
        voiceSettings.speechDetectionRules = { ...state.voiceSettings.speechDetectionRules, ...partial.speechDetectionRules }
      }
      persistKey('voiceSettings', voiceSettings)
      return { voiceSettings }
    }),

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

  setCustomCSS: (css) =>
    set((state) => {
      const customCSS = { ...state.customCSS, css, revision: state.customCSS.revision + 1 }
      persistKey('customCSS', customCSS)
      return { customCSS }
    }),

  toggleCustomCSS: (enabled) =>
    set((state) => {
      const customCSS = { ...state.customCSS, enabled }
      persistKey('customCSS', customCSS)
      return { customCSS }
    }),

  setComponentCSS: (componentName, css) =>
    set((state) => {
      const prev = state.componentOverrides[componentName]
      const componentOverrides = {
        ...state.componentOverrides,
        [componentName]: { css, tsx: prev?.tsx ?? '', enabled: prev?.enabled ?? true },
      }
      persistKey('componentOverrides', componentOverrides)
      return { componentOverrides }
    }),

  setComponentTSX: (componentName, tsx) =>
    set((state) => {
      const prev = state.componentOverrides[componentName]
      const componentOverrides = {
        ...state.componentOverrides,
        [componentName]: { tsx, css: prev?.css ?? '', enabled: prev?.enabled ?? true },
      }
      persistKey('componentOverrides', componentOverrides)
      return { componentOverrides }
    }),

  toggleComponentOverride: (componentName, enabled) =>
    set((state) => {
      const existing = state.componentOverrides[componentName]
      if (!existing) return {}
      const componentOverrides = {
        ...state.componentOverrides,
        [componentName]: { ...existing, enabled },
      }
      persistKey('componentOverrides', componentOverrides)
      return { componentOverrides }
    }),

  resetAllOverrides: () => {
    const componentOverrides = {}
    const customCSS = { css: '', enabled: false, revision: 0 }
    persistKey('componentOverrides', componentOverrides)
    persistKey('customCSS', customCSS)
    set({ componentOverrides, customCSS })
  },

  applyThemePack: (pack) => {
    const patch: Record<string, any> = {}

    // Layer 1: Theme config
    if (pack.theme) {
      patch.theme = pack.theme
      persistKey('theme', pack.theme)
    }

    // Layer 2: Global CSS
    const customCSS = { css: pack.globalCSS || '', enabled: !!pack.globalCSS.trim(), revision: Date.now() }
    patch.customCSS = customCSS
    persistKey('customCSS', customCSS)

    // Layer 3: Component overrides
    const componentOverrides: Record<string, any> = {}
    for (const [name, comp] of Object.entries(pack.components)) {
      componentOverrides[name] = { css: comp.css || '', tsx: comp.tsx || '', enabled: comp.enabled }
    }
    patch.componentOverrides = componentOverrides
    persistKey('componentOverrides', componentOverrides)

    set(patch as any)
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
