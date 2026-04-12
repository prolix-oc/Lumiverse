import type { Message, Character, Persona, Preset, ConnectionProfile, ProviderInfo, RecentChat, Pack, PackWithItems, LumiaItem, LoomItem, ImageGenConnectionProfile, ImageGenProviderInfo } from './api'

// ---- Chat Slice ----
export interface ChatSlice {
  activeChatId: string | null
  activeCharacterId: string | null
  activeChatWallpaper: WallpaperRef | null
  /** Active avatar image_id override from chat metadata (alternate avatar selection) */
  activeChatAvatarId: string | null
  messages: Message[]
  isStreaming: boolean
  streamingContent: string
  streamingReasoning: string
  streamingReasoningDuration: number | null
  streamingReasoningStartedAt: number | null
  streamingError: string | null
  activeGenerationId: string | null
  regeneratingMessageId: string | null
  streamingGenerationType: string | null
  lastPooledSeq: number | null
  totalChatLength: number
  setActiveChat: (chatId: string | null, characterId?: string | null) => void
  setActiveChatWallpaper: (wallpaper: WallpaperRef | null) => void
  setActiveChatAvatarId: (imageId: string | null) => void
  setMessages: (messages: Message[], total?: number) => void
  prependMessages: (messages: Message[]) => void
  addMessage: (message: Message) => void
  updateMessage: (id: string, updates: Partial<Message>) => void
  removeMessage: (id: string) => void
  beginStreaming: (regeneratingMessageId?: string, generationType?: string) => void
  startStreaming: (generationId: string, regeneratingMessageId?: string) => void
  appendStreamToken: (token: string) => void
  appendStreamReasoning: (token: string) => void
  replaceStreamContent: (content: string) => void
  replaceStreamReasoning: (reasoning: string) => void
  setStreamingReasoningStartedAt: (ts: number | null) => void
  setLastPooledSeq: (seq: number) => void
  endStreaming: () => void
  stopStreaming: () => void
  setStreamingError: (error: string | null) => void
  /** Set the regenerating message ID independently (e.g. when council sidecar stages a message after streaming started) */
  setRegeneratingMessageId: (messageId: string | null) => void
  /** Mark a generation ID as ended (prevents zombie resurrection from late HTTP responses) */
  markGenerationEnded: (generationId: string) => void

  // Message selection mode for bulk operations
  messageSelectMode: boolean
  selectedMessageIds: string[]
  setMessageSelectMode: (enabled: boolean) => void
  toggleMessageSelect: (id: string) => void
  selectAllMessages: () => void
  clearMessageSelection: () => void
  selectMessageRange: (fromId: string, toId: string) => void
}

// ---- Characters Slice ----
export type CharacterFilterTab = 'all' | 'characters' | 'favorites' | 'groups'
export type CharacterSortField = 'name' | 'recent' | 'created' | 'shuffle'
export type CharacterSortDirection = 'asc' | 'desc'
export type CharacterViewMode = 'grid' | 'single' | 'list'

export interface CharactersSlice {
  characters: Character[]
  charactersLoaded: boolean
  favorites: string[]
  activeCharacterId: string | null
  selectedCharacterId: string | null
  editingCharacterId: string | null
  searchQuery: string
  filterTab: CharacterFilterTab
  sortField: CharacterSortField
  sortDirection: CharacterSortDirection
  viewMode: CharacterViewMode
  selectedTags: string[]
  batchMode: boolean
  batchSelected: string[]

  setCharacters: (characters: Character[]) => void
  setCharactersLoaded: (loaded: boolean) => void
  setActiveCharacter: (id: string | null) => void
  setSelectedCharacterId: (id: string | null) => void
  setEditingCharacterId: (id: string | null) => void
  updateCharacter: (id: string, character: Character) => void
  toggleFavorite: (id: string) => void
  setSearchQuery: (query: string) => void
  addCharacter: (character: Character) => void
  addCharacters: (characters: Character[]) => void
  removeCharacter: (id: string) => void
  removeCharacters: (ids: string[]) => void
  setFilterTab: (tab: CharacterFilterTab) => void
  setSortField: (field: CharacterSortField) => void
  toggleSortDirection: () => void
  setViewMode: (mode: CharacterViewMode) => void
  setSelectedTags: (tags: string[]) => void
  toggleSelectedTag: (tag: string) => void
  setBatchMode: (enabled: boolean) => void
  toggleBatchSelect: (id: string) => void
  selectAllBatch: (ids: string[]) => void
  clearBatchSelection: () => void
}

// ---- Personas Slice ----
export type PersonaFilterType = 'all' | 'default' | 'connected'
export type PersonaSortField = 'name' | 'created'
export type PersonaSortDirection = 'asc' | 'desc'
export type PersonaViewMode = 'grid' | 'list'

export interface PersonasSlice {
  personas: Persona[]
  activePersonaId: string | null
  /** Map of characterId → personaId or binding object */
  characterPersonaBindings: Record<string, string | import('@/types/api').CharacterPersonaBinding>
  personaSearchQuery: string
  personaFilterType: PersonaFilterType
  personaSortField: PersonaSortField
  personaSortDirection: PersonaSortDirection
  personaViewMode: PersonaViewMode
  selectedPersonaId: string | null

  setPersonas: (personas: Persona[]) => void
  setActivePersona: (id: string | null) => void
  /** Bind a persona to a character (or unbind with null). Pass addonStates to snapshot addon enabled state. */
  setCharacterPersonaBinding: (characterId: string, personaId: string | null, addonStates?: Record<string, boolean>) => void
  addPersona: (persona: Persona) => void
  updatePersona: (id: string, persona: Persona) => void
  removePersona: (id: string) => void
  setPersonaSearchQuery: (query: string) => void
  setPersonaFilterType: (type: PersonaFilterType) => void
  setPersonaSortField: (field: PersonaSortField) => void
  togglePersonaSortDirection: () => void
  setPersonaViewMode: (mode: PersonaViewMode) => void
  setSelectedPersonaId: (id: string | null) => void
}

// ---- Toast Types ----
export type ToastType = 'success' | 'warning' | 'error' | 'info'
export type ToastPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'top' | 'bottom'

export interface Toast {
  id: string
  type: ToastType
  title?: string
  message: string
  duration?: number
  dismissible?: boolean
}

// ---- UI Slice ----
export interface UISlice {
  activeModal: string | null
  modalProps: Record<string, any>
  isLoading: boolean
  error: string | null
  drawerOpen: boolean
  drawerTab: string | null
  settingsModalOpen: boolean
  settingsActiveView: string
  portraitPanelOpen: boolean
  commandPaletteOpen: boolean
  toasts: Toast[]
  openModal: (name: string, props?: Record<string, any>) => void
  closeModal: () => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  openDrawer: (tab?: string) => void
  closeDrawer: () => void
  setDrawerTab: (tab: string) => void
  openSettings: (view?: string) => void
  closeSettings: () => void
  togglePortraitPanel: () => void
  openCommandPalette: () => void
  closeCommandPalette: () => void
  addToast: (toast: Omit<Toast, 'id'>) => string
  removeToast: (id: string) => void
  clearToasts: () => void

  // Badging
  badgeCount: number
  incrementBadgeCount: () => void
  resetBadgeCount: () => void

  // Regen feedback text retention
  lastRegenFeedback: string
  setLastRegenFeedback: (text: string) => void
}

// ---- OOC Style Type ----
export type OOCStyleType = 'social' | 'margin' | 'whisper' | 'raw' | 'irc'

// ---- Prompt Settings Types ----
export interface SovereignHandSettings {
  enabled: boolean
  excludeLastMessage: boolean
  includeMessageInPrompt: boolean
}

export interface ContextFilterEntry {
  enabled: boolean
  keepDepth: number
  keepOnly?: boolean
}

export interface HtmlTagsFilter extends ContextFilterEntry {
  stripFonts: boolean
  fontKeepDepth: number
}

export interface ContextFilters {
  htmlTags: HtmlTagsFilter
  detailsBlocks: ContextFilterEntry
  loomItems: ContextFilterEntry
}

// ---- Regen Feedback Settings ----
export type RegenFeedbackPosition = 'system' | 'user'

export interface RegenFeedbackSettings {
  enabled: boolean
  position: RegenFeedbackPosition
}

// ---- Reasoning Settings ----

/**
 * All possible reasoning effort values across providers.
 *
 * Provider-specific values:
 * - OpenRouter: none, minimal, low, medium, high, xhigh
 * - Google:     minimal, low, medium, high
 * - Anthropic:  low, medium, high, max
 * - NanoGPT:    none, minimal, low, medium, high
 * - Moonshot:   (toggle-only — no effort dropdown)
 * - Z.AI:       (toggle-only — no effort dropdown)
 * - Others:     auto, low, medium, high, max (generic)
 */
export type ReasoningEffort = 'auto' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'max' | 'xhigh'

export interface ReasoningSettings {
  prefix: string
  suffix: string
  autoParse: boolean
  apiReasoning: boolean
  reasoningEffort: ReasoningEffort
  /** How many recent reasoning blocks to keep in assembled prompt history.
   *  0 = strip all, -1 = keep all (unlimited), N = keep last N. */
  keepInHistory: number
}

/** Reasoning settings snapshot bound to a connection profile. */
export interface ReasoningBindings {
  settings: ReasoningSettings
}

export interface GuidedGeneration {
  id: string
  name: string
  content: string
  position: 'system' | 'user_prefix' | 'user_suffix'
  mode: 'persistent' | 'oneshot'
  enabled: boolean
  color?: string | null
}

export interface QuickReply {
  id: string
  label: string
  message: string
}

export interface QuickReplySet {
  id: string
  name: string
  color?: string | null
  enabled: boolean
  replies: QuickReply[]
}

// ---- Wallpaper Settings ----
export interface WallpaperRef {
  image_id: string
  type: 'image' | 'video'
}

export interface WallpaperSettings {
  global: WallpaperRef | null
  opacity: number
  fit: 'cover' | 'contain' | 'fill'
}

// ---- Custom CSS ----
export interface CustomCSSSettings {
  css: string
  enabled: boolean
  revision: number
}

// ---- Settings Slice ----
export interface SettingsSlice {
  landingPageChatsDisplayed: number
  charactersPerPage: number
  personasPerPage: number
  messagesPerPage: number
  chatSheldDisplayMode: 'minimal' | 'immersive' | 'bubble'
  bubbleUserAlign: 'left' | 'right'
  bubbleDisableHover: boolean
  bubbleHideAvatarBg: boolean
  chatSheldEnterToSend: boolean
  saveDraftInput: boolean
  chatWidthMode: 'full' | 'comfortable' | 'compact' | 'custom'
  chatContentMaxWidth: number
  modalWidthMode: 'full' | 'comfortable' | 'compact' | 'custom'
  modalMaxWidth: number
  portraitPanelSide: 'left' | 'right' | 'none'
  theme: ThemeConfig | null
  drawerSettings: DrawerSettings
  toastPosition: ToastPosition
  oocEnabled: boolean
  lumiaOOCStyle: OOCStyleType
  lumiaOOCInterval: number | null
  ircUseLeetHandles: boolean
  chimeraMode: boolean
  lumiaQuirks: string
  lumiaQuirksEnabled: boolean
  sovereignHand: SovereignHandSettings
  contextFilters: ContextFilters
  reasoningSettings: ReasoningSettings
  promptBias: string
  globalWorldBooks: string[]
  worldInfoSettings: import('./api').WorldInfoSettings
  regenFeedback: RegenFeedbackSettings
  guidedGenerations: GuidedGeneration[]
  quickReplySets: QuickReplySet[]
  wallpaper: WallpaperSettings
  thumbnailSettings: { smallSize: number, largeSize: number }
  pushNotificationPreferences: { enabled: boolean, events: { generation_ended: boolean, generation_error: boolean } }
  chatHeadsEnabled: boolean
  chatHeadsSize: number
  chatHeadsDirection: 'column' | 'row'
  chatHeadsOpacity: number
  customCSS: CustomCSSSettings
  componentOverrides: Record<string, import('@/lib/componentOverrides').ComponentOverride>
  voiceSettings: VoiceSettings
  setVoiceSettings: (partial: Partial<VoiceSettings>) => void
  setWallpaper: (settings: Partial<WallpaperSettings>) => void
  setSetting: <K extends keyof SettingsSlice>(key: K, value: SettingsSlice[K]) => void
  setTheme: (theme: ThemeConfig | null) => void
  setCustomCSS: (css: string) => void
  toggleCustomCSS: (enabled: boolean) => void
  setComponentCSS: (componentName: string, css: string) => void
  setComponentTSX: (componentName: string, tsx: string) => void
  toggleComponentOverride: (componentName: string, enabled: boolean) => void
  resetAllOverrides: () => void
  applyThemePack: (pack: import('@/lib/themePack').ThemePack) => void
  loadSettings: () => Promise<void>
}

import type { ThemeConfig } from './theme'
export type { ThemeConfig } from './theme'

export interface DrawerSettings {
  side: 'left' | 'right'
  verticalPosition: number
  tabSize: 'large' | 'compact'
  panelWidthMode: 'default' | 'stChat' | 'custom'
  customPanelWidth: number
  showTabLabels: boolean
}

// ---- Loom Registry Entry ----
export interface LoomRegistryEntry {
  name: string
  blockCount: number
  updatedAt: number
  isDefault: boolean
}

// ---- Presets Slice ----
export interface PresetsSlice {
  presets: Record<string, Preset>
  activePresetId: string | null
  activeLoomPresetId: string | null
  activeLumiPresetId: string | null
  loomRegistry: Record<string, LoomRegistryEntry>
  setPresets: (presets: Record<string, Preset>) => void
  setActivePreset: (id: string | null) => void
  setActiveLoomPreset: (id: string | null) => void
  setActiveLumiPreset: (id: string | null) => void
  setLoomRegistry: (registry: Record<string, LoomRegistryEntry>) => void
  /** Prefers Lumi preset when set. */
  getActivePresetForGeneration: () => string | null
}

// ---- Connections Slice ----
export interface ConnectionsSlice {
  profiles: ConnectionProfile[]
  activeProfileId: string | null
  setProfiles: (profiles: ConnectionProfile[]) => void
  setActiveProfile: (id: string | null) => void

  addProfile: (profile: ConnectionProfile) => void
  updateProfile: (id: string, updates: Partial<ConnectionProfile>) => void
  removeProfile: (id: string) => void

  providers: ProviderInfo[]
  setProviders: (providers: ProviderInfo[]) => void
}

// ---- Packs Slice ----
export type PackFilterTab = 'all' | 'custom' | 'downloaded'
export type PackSortField = 'name' | 'updated' | 'created'

export interface PacksSlice {
  packs: Pack[]
  selectedPackId: string | null
  packSearchQuery: string
  packFilterTab: PackFilterTab
  packSortField: PackSortField
  selectedDefinition: LumiaItem | null
  selectedBehaviors: LumiaItem[]
  selectedPersonalities: LumiaItem[]
  selectedLoomStyles: LoomItem[]
  selectedLoomUtils: LoomItem[]
  selectedLoomRetrofits: LoomItem[]
  packsWithItems: Record<string, PackWithItems>

  setPacks: (packs: Pack[]) => void
  addPack: (pack: Pack) => void
  updatePackInStore: (id: string, pack: Pack) => void
  removePack: (id: string) => void
  setSelectedPackId: (id: string | null) => void
  setPackSearchQuery: (query: string) => void
  setPackFilterTab: (tab: PackFilterTab) => void
  setPackSortField: (field: PackSortField) => void
  setSelectedDefinition: (def: LumiaItem | null) => void
  setSelectedBehaviors: (behaviors: LumiaItem[]) => void
  setSelectedPersonalities: (personalities: LumiaItem[]) => void
  setSelectedLoomStyles: (items: LoomItem[]) => void
  setSelectedLoomUtils: (items: LoomItem[]) => void
  setSelectedLoomRetrofits: (items: LoomItem[]) => void
  setPackWithItems: (id: string, data: PackWithItems) => void
  removePackWithItems: (id: string) => void
}

// ---- Council Slice ----
import type {
  CouncilSettings,
  CouncilToolResult,
  CouncilExecutionResult,
  CouncilToolDefinition,
  CouncilMember,
  CouncilToolsSettings,
} from 'lumiverse-spindle-types'

export interface CouncilToolsFailedInfo {
  generationId: string
  chatId: string
  failedTools: {
    memberId: string
    memberName: string
    toolName: string
    toolDisplayName: string
    error?: string
  }[]
  successCount: number
  failedCount: number
}

export interface CouncilSlice {
  councilSettings: CouncilSettings
  councilToolResults: CouncilToolResult[]
  councilExecutionResult: CouncilExecutionResult | null
  availableCouncilTools: CouncilToolDefinition[]
  councilLoading: boolean
  councilExecuting: boolean
  councilToolsFailure: CouncilToolsFailedInfo | null

  setCouncilSettings: (settings: CouncilSettings) => void
  setCouncilToolResults: (results: CouncilToolResult[]) => void
  setCouncilExecutionResult: (result: CouncilExecutionResult | null) => void
  setAvailableCouncilTools: (tools: CouncilToolDefinition[]) => void
  setCouncilLoading: (loading: boolean) => void
  setCouncilExecuting: (executing: boolean) => void
  setCouncilToolsFailure: (failure: CouncilToolsFailedInfo | null) => void

  loadCouncilSettings: () => Promise<void>
  saveCouncilSettings: (partial: Partial<CouncilSettings>) => Promise<void>
  loadAvailableTools: () => Promise<void>

  addCouncilMember: (member: CouncilMember) => void
  addCouncilMembersFromPack: (packId: string) => number
  updateCouncilMember: (id: string, updates: Partial<CouncilMember>) => void
  removeCouncilMember: (id: string) => void
  setCouncilToolsSettings: (partial: Partial<CouncilToolsSettings>) => void
}

// ---- Generation Slice ----
export interface GenerationSlice {
  imageGeneration: ImageGenSettings
  sceneBackground: string | null
  sceneGenerating: boolean
  setImageGenSettings: (settings: Partial<ImageGenSettings>) => void
  setSceneBackground: (url: string | null) => void
  setSceneGenerating: (generating: boolean) => void
}

export interface ImageGenSettings {
  enabled: boolean
  activeImageGenConnectionId?: string | null
  includeCharacters: boolean
  parameters?: Record<string, any>
  sceneChangeThreshold: number
  autoGenerate: boolean
  forceGeneration: boolean
  backgroundOpacity: number
  fadeTransitionMs: number
  /** @deprecated Legacy per-provider blocks — kept for auto-migration */
  provider?: string
  google?: Record<string, any>
  nanogpt?: Record<string, any>
  novelai?: Record<string, any>
}

// ---- Spindle Slice ----
import type { ExtensionInfo, SpindlePermission } from 'lumiverse-spindle-types'

export interface PendingPermissionRequest {
  id: string
  extensionId: string
  extensionName: string
  permissions: string[]
  reason?: string
}

export interface PendingTextEditorRequest {
  requestId: string
  extensionId: string
  title: string
  value: string
  placeholder: string
}

export interface PendingModalRequest {
  requestId: string
  extensionId: string
  extensionName: string
  title: string
  items: SpindleModalItem[]
  width?: number
  maxHeight?: number
  persistent: boolean
}

export type SpindleModalItem =
  | { type: 'text'; content: string; muted?: boolean }
  | { type: 'divider' }
  | { type: 'key_value'; label: string; value: string }
  | { type: 'heading'; content: string }
  | { type: 'card'; items: SpindleModalItem[] }

export interface PendingInputPromptRequest {
  requestId: string
  extensionId: string
  extensionName: string
  title: string
  message?: string
  placeholder?: string
  defaultValue?: string
  submitLabel?: string
  cancelLabel?: string
  multiline?: boolean
}

export interface PendingConfirmRequest {
  requestId: string
  extensionId: string
  extensionName: string
  title: string
  message: string
  variant: 'info' | 'warning' | 'danger' | 'success'
  confirmLabel: string
  cancelLabel: string
}

export interface PendingContextMenuRequest {
  requestId: string
  extensionId: string
  position: { x: number; y: number }
  items: PendingContextMenuItem[]
}

export interface PendingContextMenuItem {
  key: string
  label: string
  disabled?: boolean
  danger?: boolean
  active?: boolean
  type?: 'item' | 'divider'
}

export interface ExtensionThemeOverride {
  extensionId: string
  extensionName: string
  paletteAccent?: {
    h: number
    s: number
    l: number
  }
  variables: Record<string, string>
  variablesByMode?: {
    dark?: Record<string, string>
    light?: Record<string, string>
  }
}

export interface ExtensionOperationStatus {
  extensionId: string | null
  operation: string
  name: string | null
}

export interface SpindleSlice {
  extensions: ExtensionInfo[]
  /** Active theme overrides from Spindle extensions, keyed by extensionId */
  extensionThemeOverrides: Record<string, ExtensionThemeOverride>
  /** Extension IDs whose theme overrides are suppressed by the user */
  mutedExtensionThemes: Record<string, boolean>
  /** Real-time operation status from backend WS events */
  extensionOperationStatus: ExtensionOperationStatus | null
  spindlePrivileged: boolean
  pendingPermissionRequest: PendingPermissionRequest | null
  pendingTextEditor: PendingTextEditorRequest | null
  pendingModal: PendingModalRequest | null
  pendingConfirm: PendingConfirmRequest | null
  pendingInputPrompt: PendingInputPromptRequest | null
  pendingContextMenu: PendingContextMenuRequest | null
  loadExtensions: () => Promise<void>
  installExtension: (githubUrl: string, branch?: string | null) => Promise<void>
  updateExtension: (id: string) => Promise<void>
  switchBranch: (id: string, branch: string) => Promise<void>
  removeExtension: (id: string) => Promise<void>
  enableExtension: (id: string) => Promise<void>
  disableExtension: (id: string) => Promise<void>
  restartExtension: (id: string) => Promise<void>
  grantPermission: (id: string, permission: string) => Promise<void>
  revokePermission: (id: string, permission: string) => Promise<void>
  showPermissionRequest: (request: PendingPermissionRequest) => void
  resolvePermissionRequest: (id: string, approved: boolean) => Promise<void>
  openTextEditor: (request: PendingTextEditorRequest) => void
  closeTextEditor: (requestId: string, text: string, cancelled: boolean) => void
  openSpindleModal: (request: PendingModalRequest) => void
  closeSpindleModal: (requestId: string, dismissedBy: 'user' | 'extension' | 'cleanup') => void
  dismissSpindleModal: (requestId: string) => void
  openSpindleConfirm: (request: PendingConfirmRequest) => void
  closeSpindleConfirm: (requestId: string, confirmed: boolean) => void
  openInputPrompt: (request: PendingInputPromptRequest) => void
  closeInputPrompt: (requestId: string, value: string | null) => void
  openContextMenu: (request: PendingContextMenuRequest) => void
  closeContextMenu: (requestId: string, selectedKey: string | null) => void
  setExtensionThemeOverride: (override: ExtensionThemeOverride) => void
  clearExtensionThemeOverride: (extensionId: string) => void
  clearAllExtensionThemeOverrides: () => void
  muteExtensionTheme: (extensionId: string) => void
  unmuteExtensionTheme: (extensionId: string) => void
  setExtensionOperationStatus: (extensionId: string | null, operation: string, name: string | null) => void
}

// ---- Summary Slice ----
import type { SummarizationSettings } from '@/lib/summary/types'

export interface SummarySlice {
  summarization: SummarizationSettings
  isSummarizing: boolean
  setSummarization: (settings: Partial<SummarizationSettings>) => void
  setIsSummarizing: (value: boolean) => void
}

// ---- Auth Slice ----
export interface AuthUser {
  id: string
  name: string
  email: string
  username?: string
  role?: string
  image?: string | null
  banned?: boolean | number
}

export interface AuthSession {
  id: string
  userId: string
  token: string
  expiresAt: string
}

export interface AuthSlice {
  user: AuthUser | null
  session: AuthSession | null
  isAuthenticated: boolean
  isAuthLoading: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  checkSession: () => Promise<void>
  createUser: (username: string, password: string, role?: string) => Promise<void>
  listUsers: () => Promise<AuthUser[]>
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>
  resetUserPassword: (userId: string, newPassword: string) => Promise<void>
  banUser: (userId: string) => Promise<void>
  unbanUser: (userId: string) => Promise<void>
  deleteUser: (userId: string) => Promise<void>
  /** Reconcile user role from a trusted source (e.g. WS CONNECTED event) */
  reconcileRole: (role: string) => void
}

// ---- World Info Slice ----
import type { ActivatedWorldInfoEntry, WorldInfoStats } from './api'

export interface WorldInfoSlice {
  activatedWorldInfo: ActivatedWorldInfoEntry[]
  worldInfoStats: WorldInfoStats | null
  setActivatedWorldInfo: (entries: ActivatedWorldInfoEntry[], stats?: WorldInfoStats | null) => void
  clearActivatedWorldInfo: () => void
}

// Lumi Feedback Slice
import type { LumiModuleDonePayload, LumiPipelineCompletedPayload } from './ws-events'

export interface LumiSlice {
  lumiExecuting: boolean
  lumiResults: LumiModuleDonePayload[]
  lumiPipelineResult: LumiPipelineCompletedPayload | null

  setLumiExecuting: (executing: boolean) => void
  setLumiResults: (results: LumiModuleDonePayload[]) => void
  addLumiResult: (result: LumiModuleDonePayload) => void
  setLumiPipelineResult: (result: LumiPipelineCompletedPayload | null) => void
  clearLumiResults: () => void
}

// ---- Group Chat Slice ----
export interface GroupChatSlice {
  isGroupChat: boolean
  groupCharacterIds: string[]
  mutedCharacterIds: string[]
  roundCharactersSpoken: string[]
  roundTotal: number
  currentRound: number
  isNudgeLoopActive: boolean
  activeGroupCharacterId: string | null

  setGroupChat: (isGroup: boolean, characterIds: string[], mutedIds?: string[]) => void
  clearGroupChat: () => void
  markCharacterSpoken: (characterId: string) => void
  startNewRound: (total: number) => void
  setNudgeLoopActive: (active: boolean) => void
  setActiveGroupCharacter: (characterId: string | null) => void
  setGroupCharacterIds: (ids: string[]) => void
  setMutedCharacterIds: (ids: string[]) => void
  toggleMuteCharacter: (characterId: string) => string[]
}

// ---- Spindle Placement Slice ----
import type {
  DrawerTabState,
  FloatWidgetState,
  DockPanelState,
  AppMountState,
  InputBarActionState,
  ExtensionCommandState,
} from '@/store/slices/spindle-placement'

export interface SpindlePlacementSlice {
  drawerTabs: DrawerTabState[]
  floatWidgets: FloatWidgetState[]
  dockPanels: DockPanelState[]
  appMounts: AppMountState[]
  inputBarActions: InputBarActionState[]
  extensionCommands: ExtensionCommandState[]
  hiddenPlacements: string[]

  registerDrawerTab: (tab: DrawerTabState) => void
  unregisterDrawerTab: (tabId: string) => void
  updateDrawerTab: (tabId: string, updates: Partial<Pick<DrawerTabState, 'title' | 'shortName' | 'badge'>>) => void

  registerFloatWidget: (widget: FloatWidgetState) => void
  unregisterFloatWidget: (widgetId: string) => void
  updateFloatWidget: (widgetId: string, updates: Partial<Pick<FloatWidgetState, 'x' | 'y' | 'visible'>>) => void

  registerDockPanel: (panel: DockPanelState) => void
  unregisterDockPanel: (panelId: string) => void
  updateDockPanel: (panelId: string, updates: Partial<Pick<DockPanelState, 'title' | 'collapsed' | 'size'>>) => void

  registerAppMount: (mount: AppMountState) => void
  unregisterAppMount: (mountId: string) => void
  updateAppMount: (mountId: string, updates: Partial<Pick<AppMountState, 'visible'>>) => void

  registerInputBarAction: (action: InputBarActionState) => void
  unregisterInputBarAction: (actionId: string) => void
  updateInputBarAction: (actionId: string, updates: Partial<Pick<InputBarActionState, 'label' | 'enabled'>>) => void

  setExtensionCommands: (entry: ExtensionCommandState) => void
  clearExtensionCommands: (extensionId: string) => void

  removeAllByExtension: (extensionId: string) => void
  togglePlacementVisibility: (placementId: string) => void
  setPlacementHidden: (placementId: string, hidden: boolean) => void
  showAllPlacements: () => void
  hideAllPlacements: () => void
}

// ---- Prompt Breakdown Slice ----
export interface BreakdownCacheEntry {
  entries: { name: string; type: string; tokens: number; role?: string; blockId?: string }[]
  totalTokens: number
  maxContext: number
  model: string
  provider: string
  presetName?: string
  tokenizer_name: string | null
  chatId?: string
}

export interface PromptBreakdownSlice {
  breakdownCache: Record<string, BreakdownCacheEntry>
  cacheBreakdown: (messageId: string, data: BreakdownCacheEntry) => void
  clearBreakdownsForChat: (chatId: string) => void
}

// ---- Regex Slice ----
import type { RegexScript, CreateRegexScriptInput, UpdateRegexScriptInput } from '@/types/regex'

export interface RegexSlice {
  regexScripts: RegexScript[]
  regexEditingId: string | null
  loadRegexScripts: () => Promise<void>
  addRegexScript: (input: CreateRegexScriptInput) => Promise<RegexScript>
  updateRegexScript: (id: string, updates: UpdateRegexScriptInput) => Promise<void>
  removeRegexScript: (id: string) => Promise<void>
  reorderRegexScripts: (fromIdx: number, toIdx: number) => Promise<void>
  toggleRegexScript: (id: string, disabled: boolean) => Promise<void>
  setRegexEditingId: (id: string | null) => void
}

// ---- Expression Slice ----
import type { ExpressionDisplaySettings } from '@/types/expressions'

export interface GroupExpressionEntry {
  label: string
  imageId: string
}

export interface ExpressionSlice {
  currentExpression: string | null
  currentExpressionImageId: string | null
  previousExpressionImageId: string | null
  expressionCharacterId: string | null
  expressionDisplay: ExpressionDisplaySettings
  /** Per-character expression state for group chats (characterId → label+imageId) */
  groupExpressions: Record<string, GroupExpressionEntry>
  /** Character currently generating a response (set via GENERATION_STARTED, cleared on GENERATION_ENDED) */
  respondingCharacterId: string | null
  setActiveExpression: (label: string | null, imageId: string | null, characterId: string | null) => void
  setGroupExpression: (characterId: string, label: string, imageId: string) => void
  setGroupExpressions: (map: Record<string, GroupExpressionEntry>) => void
  clearGroupExpressions: () => void
  setRespondingCharacterId: (characterId: string | null) => void
  setExpressionDisplay: (partial: Partial<ExpressionDisplaySettings>) => void
  toggleExpressionMinimized: () => void
}

// ---- Image Gen Connections Slice ----
export interface ImageGenConnectionsSlice {
  imageGenProfiles: ImageGenConnectionProfile[]
  activeImageGenConnectionId: string | null
  imageGenProviders: ImageGenProviderInfo[]

  setImageGenProfiles: (profiles: ImageGenConnectionProfile[]) => void
  setActiveImageGenConnection: (id: string | null) => void
  addImageGenProfile: (profile: ImageGenConnectionProfile) => void
  updateImageGenProfile: (id: string, updates: Partial<ImageGenConnectionProfile>) => void
  removeImageGenProfile: (id: string) => void
  setImageGenProviders: (providers: ImageGenProviderInfo[]) => void
}

// ---- MCP Servers Slice ----
export interface McpServersSlice {
  mcpServers: import('@/api/mcp-servers').McpServerProfile[]
  mcpServerStatuses: Record<string, import('@/api/mcp-servers').McpServerStatus>

  setMcpServers: (servers: import('@/api/mcp-servers').McpServerProfile[]) => void
  addMcpServer: (server: import('@/api/mcp-servers').McpServerProfile) => void
  updateMcpServer: (id: string, updates: Partial<import('@/api/mcp-servers').McpServerProfile>) => void
  removeMcpServer: (id: string) => void
  setMcpServerStatus: (id: string, status: import('@/api/mcp-servers').McpServerStatus) => void
}

// ---- TTS Connections Slice ----
export interface TtsConnectionsSlice {
  ttsProfiles: import('@/types/api').TtsConnectionProfile[]
  ttsProviders: import('@/types/api').TtsProviderInfo[]

  setTtsProfiles: (profiles: import('@/types/api').TtsConnectionProfile[]) => void
  addTtsProfile: (profile: import('@/types/api').TtsConnectionProfile) => void
  updateTtsProfile: (id: string, updates: Partial<import('@/types/api').TtsConnectionProfile>) => void
  removeTtsProfile: (id: string) => void
  setTtsProviders: (providers: import('@/types/api').TtsProviderInfo[]) => void
}

// ---- Voice Settings ----
export interface SpeechDetectionRules {
  asterisked: 'skip' | 'narration'
  quoted: 'speech' | 'narration' | 'skip'
  undecorated: 'narration' | 'speech' | 'skip'
}

export interface VoiceSettings {
  sttProvider: 'webspeech' | 'openai'
  sttLanguage: string
  sttContinuous: boolean
  sttInterimResults: boolean
  sttConnectionId: string | null
  ttsEnabled: boolean
  ttsConnectionId: string | null
  ttsAutoPlay: boolean
  ttsSpeed: number
  ttsVolume: number
  speechDetectionRules: SpeechDetectionRules
}

// ---- Loadouts Slice ----
export interface LoadoutsSlice {
  loadouts: import('@/api/loadouts').Loadout[]
  activeLoadoutId: string | null
  loadoutsLoading: boolean
  loadLoadouts: () => Promise<void>
  createLoadout: (name: string) => Promise<import('@/api/loadouts').Loadout | null>
  updateLoadout: (id: string, updates: { name?: string; recapture?: boolean }) => Promise<void>
  deleteLoadout: (id: string) => Promise<void>
  applyLoadout: (id: string) => Promise<void>
  setActiveLoadoutId: (id: string | null) => void
}

// ---- Migration Slice ----
export interface MigrationSlice {
  migrationId: string | null
  migrationPhase: string | null
  migrationProgress: { current: number; total: number; label: string } | null
  migrationLogs: { level: string; message: string; timestamp: number }[]
  migrationResult: import('@/types/ws-events').MigrationCompletedPayload | null
  migrationError: string | null

  setMigrationStarted: (id: string) => void
  setMigrationProgress: (payload: import('@/types/ws-events').MigrationProgressPayload) => void
  addMigrationLog: (payload: import('@/types/ws-events').MigrationLogPayload) => void
  setMigrationCompleted: (payload: import('@/types/ws-events').MigrationCompletedPayload) => void
  setMigrationFailed: (payload: import('@/types/ws-events').MigrationFailedPayload) => void
  resetMigration: () => void
}

// ---- Operator Slice ----
import type { OperatorLogEntry, OperatorStatusPayload } from '@/types/ws-events'

export interface OperatorSlice {
  operatorLogs: OperatorLogEntry[]
  operatorStatus: OperatorStatusPayload | null
  operatorBusy: string | null
  appendOperatorLogs: (entries: OperatorLogEntry[]) => void
  setOperatorStatus: (status: OperatorStatusPayload) => void
  setOperatorBusy: (operation: string | null) => void
  clearOperatorLogs: () => void
}

// ---- Floating Avatar Slice ----
export interface FloatingAvatarState {
  imageUrl: string
  displayName: string
  x: number
  y: number
  width: number
  height: number
}

export interface FloatingAvatarSlice {
  floatingAvatar: FloatingAvatarState | null
  openFloatingAvatar: (imageUrl: string, displayName: string) => void
  updateFloatingAvatar: (partial: Partial<FloatingAvatarState>) => void
  closeFloatingAvatar: () => void
}

// ---- Chat Heads (floating generation status) ----

export type ChatHeadStatus = 'assembling' | 'council' | 'council_failed' | 'reasoning' | 'streaming' | 'completed' | 'stopped' | 'error'

export interface ChatHeadEntry {
  generationId: string
  chatId: string
  characterName: string
  characterId?: string
  avatarUrl: string | null
  status: ChatHeadStatus
  model: string
  startedAt: number
}

export interface ChatHeadsSlice {
  chatHeads: ChatHeadEntry[]
  /** Position stored as percentage of viewport (0-1) for responsive persistence */
  chatHeadsPosition: { xPct: number; yPct: number }
  addChatHead: (head: ChatHeadEntry) => void
  updateChatHead: (generationId: string, updates: Partial<ChatHeadEntry>) => void
  removeChatHead: (chatId: string) => void
  setChatHeadsPosition: (pos: { xPct: number; yPct: number }) => void
  /** Re-sync persisted heads against the backend's active generation list */
  reconcileChatHeads: () => Promise<void>
}

export interface DatabankSlice {
  databanks: import('@/api/databank').Databank[]
  databankDocuments: import('@/api/databank').DatabankDocument[]
  selectedDatabankId: string | null
  databankScopeFilter: 'global' | 'character' | 'chat'
  databankScopeCharacterId: string | null
  setDatabanks: (banks: import('@/api/databank').Databank[]) => void
  addDatabank: (bank: import('@/api/databank').Databank) => void
  updateDatabank: (id: string, updates: Partial<import('@/api/databank').Databank>) => void
  removeDatabank: (id: string) => void
  setSelectedDatabankId: (id: string | null) => void
  setDatabankScopeFilter: (scope: 'global' | 'character' | 'chat') => void
  setDatabankScopeCharacterId: (id: string | null) => void
  setDatabankDocuments: (docs: import('@/api/databank').DatabankDocument[]) => void
  addDatabankDocument: (doc: import('@/api/databank').DatabankDocument) => void
  updateDatabankDocument: (id: string, updates: Partial<import('@/api/databank').DatabankDocument>) => void
  removeDatabankDocument: (id: string) => void
}

// ---- Combined Store ----
export type AppStore = ChatSlice &
  CharactersSlice &
  PersonasSlice &
  UISlice &
  SettingsSlice &
  PresetsSlice &
  ConnectionsSlice &
  PacksSlice &
  CouncilSlice &
  LumiSlice &
  GenerationSlice &
  SummarySlice &
  SpindleSlice &
  AuthSlice &
  WorldInfoSlice &
  GroupChatSlice &
  SpindlePlacementSlice &
  PromptBreakdownSlice &
  RegexSlice &
  ExpressionSlice &
  ImageGenConnectionsSlice &
  TtsConnectionsSlice &
  McpServersSlice &
  LoadoutsSlice &
  MigrationSlice &
  OperatorSlice &
  FloatingAvatarSlice &
  ChatHeadsSlice &
  DatabankSlice
