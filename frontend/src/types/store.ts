import type { Message, Character, Persona, Preset, ConnectionProfile, ProviderInfo, RecentChat, Pack, PackWithItems, LumiaItem } from './api'

// ---- Chat Slice ----
export interface ChatSlice {
  activeChatId: string | null
  activeCharacterId: string | null
  messages: Message[]
  isStreaming: boolean
  streamingContent: string
  streamingReasoning: string
  streamingError: string | null
  activeGenerationId: string | null
  regeneratingMessageId: string | null
  streamingGenerationType: string | null
  totalChatLength: number
  setActiveChat: (chatId: string | null, characterId?: string | null) => void
  setMessages: (messages: Message[], total?: number) => void
  prependMessages: (messages: Message[]) => void
  addMessage: (message: Message) => void
  updateMessage: (id: string, updates: Partial<Message>) => void
  removeMessage: (id: string) => void
  beginStreaming: (regeneratingMessageId?: string, generationType?: string) => void
  startStreaming: (generationId: string, regeneratingMessageId?: string) => void
  appendStreamToken: (token: string) => void
  appendStreamReasoning: (token: string) => void
  endStreaming: () => void
  stopStreaming: () => void
  setStreamingError: (error: string | null) => void
  /** Set the regenerating message ID independently (e.g. when council sidecar stages a message after streaming started) */
  setRegeneratingMessageId: (messageId: string | null) => void
  /** Mark a generation ID as ended (prevents zombie resurrection from late HTTP responses) */
  markGenerationEnded: (generationId: string) => void
}

// ---- Characters Slice ----
export type CharacterFilterTab = 'all' | 'characters' | 'favorites' | 'groups'
export type CharacterSortField = 'name' | 'recent' | 'created'
export type CharacterSortDirection = 'asc' | 'desc'
export type CharacterViewMode = 'grid' | 'columns' | 'list'

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
  personaSearchQuery: string
  personaFilterType: PersonaFilterType
  personaSortField: PersonaSortField
  personaSortDirection: PersonaSortDirection
  personaViewMode: PersonaViewMode
  selectedPersonaId: string | null

  setPersonas: (personas: Persona[]) => void
  setActivePersona: (id: string | null) => void
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

// ---- Reasoning Settings ----
export interface ReasoningSettings {
  prefix: string
  suffix: string
  autoParse: boolean
  apiReasoning: boolean
  reasoningEffort: 'auto' | 'low' | 'medium' | 'high' | 'max'
  /** How many recent reasoning blocks to keep in assembled prompt history.
   *  0 = strip all, -1 = keep all (unlimited), N = keep last N. */
  keepInHistory: number
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

// ---- Settings Slice ----
export interface SettingsSlice {
  enableLandingPage: boolean
  landingPageChatsDisplayed: number
  charactersPerPage: number
  personasPerPage: number
  chatSheldDisplayMode: 'minimal' | 'immersive' | 'bubble'
  bubbleUserAlign: 'left' | 'right'
  chatSheldEnterToSend: boolean
  chatWidthMode: 'full' | 'comfortable' | 'compact' | 'custom'
  chatContentMaxWidth: number
  modalWidthMode: 'full' | 'comfortable' | 'compact' | 'custom'
  modalMaxWidth: number
  portraitPanelSide: 'left' | 'right'
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
  guidedGenerations: GuidedGeneration[]
  quickReplySets: QuickReplySet[]
  setSetting: <K extends keyof SettingsSlice>(key: K, value: SettingsSlice[K]) => void
  setTheme: (theme: ThemeConfig | null) => void
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
  loomRegistry: Record<string, LoomRegistryEntry>
  setPresets: (presets: Record<string, Preset>) => void
  setActivePreset: (id: string | null) => void
  setActiveLoomPreset: (id: string | null) => void
  setLoomRegistry: (registry: Record<string, LoomRegistryEntry>) => void
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

export interface CouncilSlice {
  councilSettings: CouncilSettings
  councilToolResults: CouncilToolResult[]
  councilExecutionResult: CouncilExecutionResult | null
  availableCouncilTools: CouncilToolDefinition[]
  councilLoading: boolean
  councilExecuting: boolean

  setCouncilSettings: (settings: CouncilSettings) => void
  setCouncilToolResults: (results: CouncilToolResult[]) => void
  setCouncilExecutionResult: (result: CouncilExecutionResult | null) => void
  setAvailableCouncilTools: (tools: CouncilToolDefinition[]) => void
  setCouncilLoading: (loading: boolean) => void
  setCouncilExecuting: (executing: boolean) => void

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
  provider: string
  includeCharacters: boolean
  google: Record<string, any>
  nanogpt: Record<string, any>
  novelai: Record<string, any>
  sceneChangeThreshold: number
  autoGenerate: boolean
  forceGeneration: boolean
  backgroundOpacity: number
  fadeTransitionMs: number
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

export interface SpindleSlice {
  extensions: ExtensionInfo[]
  spindlePrivileged: boolean
  pendingPermissionRequest: PendingPermissionRequest | null
  loadExtensions: () => Promise<void>
  installExtension: (githubUrl: string) => Promise<void>
  updateExtension: (id: string) => Promise<void>
  removeExtension: (id: string) => Promise<void>
  enableExtension: (id: string) => Promise<void>
  disableExtension: (id: string) => Promise<void>
  restartExtension: (id: string) => Promise<void>
  grantPermission: (id: string, permission: string) => Promise<void>
  revokePermission: (id: string, permission: string) => Promise<void>
  showPermissionRequest: (request: PendingPermissionRequest) => void
  resolvePermissionRequest: (id: string, approved: boolean) => Promise<void>
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
import type { ActivatedWorldInfoEntry } from './api'

export interface WorldInfoSlice {
  activatedWorldInfo: ActivatedWorldInfoEntry[]
  setActivatedWorldInfo: (entries: ActivatedWorldInfoEntry[]) => void
  clearActivatedWorldInfo: () => void
}

// ---- Group Chat Slice ----
export interface GroupChatSlice {
  isGroupChat: boolean
  groupCharacterIds: string[]
  roundCharactersSpoken: string[]
  roundTotal: number
  currentRound: number
  isNudgeLoopActive: boolean
  activeGroupCharacterId: string | null

  setGroupChat: (isGroup: boolean, characterIds: string[]) => void
  clearGroupChat: () => void
  markCharacterSpoken: (characterId: string) => void
  startNewRound: (total: number) => void
  setNudgeLoopActive: (active: boolean) => void
  setActiveGroupCharacter: (characterId: string | null) => void
}

// ---- Spindle Placement Slice ----
import type {
  DrawerTabState,
  FloatWidgetState,
  DockPanelState,
  AppMountState,
  InputBarActionState,
} from '@/store/slices/spindle-placement'

export interface SpindlePlacementSlice {
  drawerTabs: DrawerTabState[]
  floatWidgets: FloatWidgetState[]
  dockPanels: DockPanelState[]
  appMounts: AppMountState[]
  inputBarActions: InputBarActionState[]
  hiddenPlacements: string[]

  registerDrawerTab: (tab: DrawerTabState) => void
  unregisterDrawerTab: (tabId: string) => void
  updateDrawerTab: (tabId: string, updates: Partial<Pick<DrawerTabState, 'title' | 'badge'>>) => void

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
  GenerationSlice &
  SummarySlice &
  SpindleSlice &
  AuthSlice &
  WorldInfoSlice &
  GroupChatSlice &
  SpindlePlacementSlice &
  PromptBreakdownSlice
