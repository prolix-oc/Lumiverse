import { settingsAuthorityRows } from './core-setting-keys'

export type FrontendAuthoritySurface =
  | 'state_selector'
  | 'ctx_member'
  | 'host_surface'
  | 'host_action'
  | 'legacy_ctx_member'

export interface AuthorityRow {
  surface: FrontendAuthoritySurface
  id: string
  source: string
  permission: string | null
  ctxLeaf?: string
  composedOf?: readonly string[]
  freeBecause?: string | readonly string[]
  gatedBecause?: string
  grandfathered?: string
}

type FreeRow = Omit<AuthorityRow, 'permission' | 'gatedBecause'>
type GatedRow = Omit<AuthorityRow, 'permission' | 'freeBecause'>

const free = (row: FreeRow): AuthorityRow => ({ ...row, permission: null })
const gated = (permission: string, row: GatedRow): AuthorityRow => ({ ...row, permission })

const SELECTOR_ROWS: readonly AuthorityRow[] = [
  free({ surface: 'state_selector', id: 'ui.activeModal', source: 'ui.activeModal', freeBecause: 'limb-e: modal name is observable in shared chrome; modal props never cross the boundary' }),
  free({ surface: 'state_selector', id: 'ui.drawer', source: 'ui.drawer', freeBecause: 'limb-e: shipped ctx.ui.events.getDrawerState is the exact drawer-state twin' }),
  free({ surface: 'state_selector', id: 'ui.settings', source: 'ui.settings', freeBecause: 'limb-e: shipped ctx.ui.events.getSettingsState is the exact settings-state twin' }),
  free({ surface: 'state_selector', id: 'ui.layout', source: 'ui.layout', freeBecause: 'limb-e: layout geometry is observable in the shared DOM' }),
  free({ surface: 'state_selector', id: 'chat.active', source: 'chat.active', freeBecause: [
    'limb-e: chatId and characterId are observable through shipped ctx.getActiveChat',
    'rest: avatarImageId is returned by GET /api/v1/chats/:id metadata.active_avatar_id',
  ] }),
  free({ surface: 'state_selector', id: 'chat.messageCount', source: 'chat.messageCount', freeBecause: 'limb-e: shipped ctx.messages.listMessageIds exposes the same count' }),
  free({ surface: 'state_selector', id: 'characters.favorites', source: 'settings.favorites', freeBecause: 'rest: GET /api/v1/settings/favorites returns the same authenticated-session preference' }),
  free({
    surface: 'state_selector',
    id: 'characters.browser',
    source: 'settings.characterBrowserPrefs',
    composedOf: ['settings.filterTab', 'settings.sortField', 'settings.sortDirection', 'settings.viewMode'],
    freeBecause: 'rest: GET /api/v1/settings/<key> returns the existing authenticated-session browser preference',
  }),
  gated('characters', { surface: 'state_selector', id: 'characters.editingId', source: 'characters.editingId', gatedBecause: 'Rule-B clause (d): transient editing state names a protected character entity' }),
  free({ surface: 'state_selector', id: 'connections.active', source: 'connections.active', freeBecause: 'rest: GET /api/v1/connections exposes the authenticated active-profile projection' }),
  free({ surface: 'state_selector', id: 'connections.profiles', source: 'connections.list', freeBecause: 'rest: GET /api/v1/connections returns credential-redacted profiles for the authenticated session' }),
  free({ surface: 'state_selector', id: 'worldInfo.activated', source: 'worldInfo.activated', freeBecause: "shipped-twin: ctx.events.on('WORLD_INFO_ACTIVATED') already delivers id, comment, keys, bookName, and bookSource:'peer'; never content; worker-host.ts:2001-2003 gates only the backend twin" }),
  free({ surface: 'state_selector', id: 'worldInfo.selectedEntryId', source: 'worldInfo.selectedEntryId', freeBecause: 'limb-e: the selected world-book entry identifier is editor selection metadata; no entry content crosses the boundary' }),
  free({ surface: 'state_selector', id: 'loom.activePresetId', source: 'loom.activePresetId', freeBecause: 'rest: the authenticated session exposes the active Loom preset identifier as read-only state' }),
  free({ surface: 'state_selector', id: 'persona.activeId', source: 'persona.activeId', freeBecause: 'rest: the authenticated session exposes the active persona identifier as read-only state' }),
]

const DRAWER_TAB_IDS = [
  'profile', 'presets', 'loom', 'weaver', 'connections', 'browser', 'characters',
  'personas', 'multiplayer', 'lorebook', 'cortex', 'databank', 'create', 'ooc',
  'prompt', 'council', 'summary', 'feedback', 'worldinfo', 'imagegen', 'wallpaper',
  'regex', 'branches', 'theme', 'spindle',
] as const

const SETTINGS_TAB_IDS = [
  'productivity', 'account', 'display', 'chat', 'extensions', 'guided', 'quickReplies', 'extensionPools',
  'webSearch', 'embeddings', 'memoryCortex', 'agentRuntime', 'notifications', 'voice', 'mcpServers',
  'advanced', 'lumihub', 'illarin', 'dataPortability', 'diagnostics', 'streamDeck', 'ssoProviders', 'operator',
  'tokenizers', 'users', 'migration',
] as const

const CORE_ACTION_ROWS: readonly AuthorityRow[] = [
  gated('generation', { surface: 'host_action', id: 'command:action-regenerate', source: 'generation.regenerate', gatedBecause: 'Rule-B clause (a): starts credentialed provider generation' }),
  gated('generation', { surface: 'host_action', id: 'command:action-continue', source: 'generation.continue', gatedBecause: 'Rule-B clause (a): starts credentialed provider generation' }),
  free({ surface: 'host_action', id: 'command:action-new-chat', source: 'nav.route:/', freeBecause: 'pure-host-action: navigates to an allowlisted landing route' }),
  free({ surface: 'host_action', id: 'command:action-character-browser', source: 'nav.route:/characters', freeBecause: 'pure-host-action: navigates to an allowlisted character route' }),
  gated('characters', { surface: 'host_action', id: 'command:action-import-character', source: 'characters.import', gatedBecause: 'Rule-B clause (b): durable character write after a user file selection' }),
  free({ surface: 'host_action', id: 'command:action-new-chat-same-character', source: 'nav.route:/', freeBecause: 'pure-host-action: navigates to an allowlisted landing route and changes transient selection' }),
  gated('chats', { surface: 'host_action', id: 'command:action-fork-chat', source: 'chats.fork', gatedBecause: 'Rule-B clause (b): durable chat write' }),
  free({ surface: 'host_action', id: 'command:action-manage-chats', source: 'ui.openModal:manageChats', freeBecause: 'pure-host-action: opens a host modal with props derived from current host state' }),
  free({ surface: 'host_action', id: 'command:action-copy-last-message', source: 'messages.content', freeBecause: 'limb-e: copies content already exposed by the shipped message read surface; clipboard caveat is documented' }),
  gated('chats', { surface: 'host_action', id: 'command:action-delete-last-message', source: 'chats.message.delete', gatedBecause: 'Rule-B clause (b): durable destructive message write' }),
  gated('chats', { surface: 'host_action', id: 'command:action-toggle-hidden-last', source: 'chats.message.update', gatedBecause: 'Rule-B clause (b): durable message mutation via messagesApi.update' }),
  gated('generation', { surface: 'host_action', id: 'command:action-dry-run', source: 'generation.dryRun', gatedBecause: 'Rule-B clause (a): resolves the stored provider credential and can perform outbound generation work' }),
  free({ surface: 'host_action', id: 'command:action-edit-character', source: 'nav.route:/characters/:id', freeBecause: 'pure-host-action: navigates to an allowlisted character route' }),
  gated('characters', { surface: 'host_action', id: 'command:action-duplicate-character', source: 'characters.duplicate', gatedBecause: 'Rule-B clause (b): durable character write' }),
  free({ surface: 'host_action', id: 'command:action-toggle-portrait', source: 'ui.togglePortrait', freeBecause: 'pure-host-action: toggles host chrome without reading or writing an entity' }),
  gated('chats', { surface: 'host_action', id: 'command:action-delete-chat', source: 'chats.delete', gatedBecause: 'Rule-B clause (b): durable destructive chat write' }),
]

const HOST_ACTION_ROWS: readonly AuthorityRow[] = [
  ...CORE_ACTION_ROWS,
  ...DRAWER_TAB_IDS.flatMap((id) => [
    free({ surface: 'host_action' as const, id: `drawer_tab:${id}`, source: `ui.openDrawer:${id}`, freeBecause: 'pure-host-action: opens a registered host drawer tab' }),
    free({ surface: 'host_action' as const, id: `command:panel-${id}`, source: `ui.openDrawer:${id}`, freeBecause: 'pure-host-action: opens a registered host drawer tab' }),
  ]),
  ...SETTINGS_TAB_IDS.flatMap((id) => [
    free({ surface: 'host_action' as const, id: `settings_tab:${id}`, source: `ui.openSettings:${id}`, freeBecause: 'pure-host-action: opens a role-filtered host settings tab' }),
    free({ surface: 'host_action' as const, id: `command:settings-${id}`, source: `ui.openSettings:${id}`, freeBecause: 'pure-host-action: opens a role-filtered host settings tab' }),
  ]),
  free({ surface: 'host_action', id: 'route:/', source: 'nav.route:/', freeBecause: 'pure-host-action: React Router navigation to an allowlisted route' }),
  free({ surface: 'host_action', id: 'route:/chat/:chatId', source: 'nav.route:/chat/:chatId', freeBecause: 'pure-host-action: React Router navigation to an allowlisted route' }),
  free({ surface: 'host_action', id: 'route:/characters', source: 'nav.route:/characters', freeBecause: 'pure-host-action: React Router navigation to an allowlisted route' }),
  free({ surface: 'host_action', id: 'route:/characters/:id', source: 'nav.route:/characters/:id', freeBecause: 'pure-host-action: React Router navigation to an allowlisted route' }),
  gated('characters', { surface: 'host_action', id: 'modal:character_editor', source: 'characters.editingId', gatedBecause: 'Rule-B clause (d): opens the protected character-editor entity by id' }),
  gated('world_books', { surface: 'host_action', id: 'modal:world_book_editor', source: 'worldBooks.editor', gatedBecause: 'Rule-B clause (d): opens a protected world-book entity by id' }),
  free({ surface: 'host_action', id: 'input_bar_action:self', source: 'ui.inputBarAction.self', freeBecause: 'pure-host-action: invokes the caller extension’s own registered handler' }),
  gated('app_manipulation', { surface: 'host_action', id: 'input_bar_action:cross_extension', source: 'ui.inputBarAction.crossExtension', gatedBecause: 'Rule-B clause (c): invokes another extension’s handler under its owner boundary' }),
  free({ surface: 'host_action', id: 'ext_command:self', source: 'ui.extCommand.self', freeBecause: 'pure-host-action: invokes the caller extension’s own backend command' }),
  gated('app_manipulation', { surface: 'host_action', id: 'ext_command:cross_extension', source: 'ui.extCommand.crossExtension', gatedBecause: 'Rule-B clause (c): invokes another extension backend under its owner boundary' }),
]

const HOST_SURFACE_ROWS: readonly AuthorityRow[] = [
  free({ surface: 'host_surface', id: 'provider_icon', source: 'hostSurface.providerIcon', freeBecause: 'pure-host-action: renders a static provider glyph from a string id' }),
  gated('world_books', { surface: 'host_surface', id: 'world_book_entry_editor', source: 'hostSurface.worldBookEntryEditor', gatedBecause: 'Rule-B clause (b): the host wrapper binds editor events to the durable worldBooksApi.updateEntry write' }),
  free({ surface: 'host_surface', id: 'world_book_entry_table', source: 'worldBooks.entries', freeBecause: 'rest: session-authenticated world-book entries are display-only here' }),
  free({ surface: 'host_surface', id: 'character_card', source: 'characters.summary', freeBecause: 'rest: session-authenticated character summaries are display-only here' }),
  free({ surface: 'host_surface', id: 'character_library_grid', source: 'characters.summary', freeBecause: 'rest: display-only character summary data' }),
  free({ surface: 'host_surface', id: 'character_preview_panel', source: 'characters.summary', freeBecause: 'rest: display-only character summary data' }),
  free({ surface: 'host_surface', id: 'homepage_character_library', source: 'characters.summary', freeBecause: 'rest: renders the host-owned homepage character library component' }),
  free({ surface: 'host_surface', id: 'token_count_button', source: 'connections.list', freeBecause: 'rest: counts caller-supplied text and reads credential-redacted profiles' }),
  free({ surface: 'host_surface', id: 'productivity.settings.workspace', source: 'settings.productivity_surface', freeBecause: 'pure-host-action: renders negotiated preference controls; commands remain host-routed events' }),
  free({ surface: 'host_surface', id: 'quick_toolbar.workspace', source: 'ui.quick_toolbar', freeBecause: 'pure-host-action: renders negotiated toolbar commands without provider access' }),
  gated('generation', { surface: 'host_surface', id: 'connections_picker.launcher', source: 'connections.picker', gatedBecause: 'Rule-B clause (c): host-routed picker commands can change generation routing' }),
  gated('generation', { surface: 'host_surface', id: 'connections_picker.panel', source: 'connections.picker', gatedBecause: 'Rule-B clause (c): host-routed picker commands can change generation routing' }),
  free({ surface: 'host_surface', id: 'activated_lore.indicator', source: 'worldInfo.activated', freeBecause: 'shipped-twin: renders activation metadata already delivered by WORLD_INFO_ACTIVATED' }),
  free({ surface: 'host_surface', id: 'activated_lore.panel', source: 'worldInfo.activated', freeBecause: 'shipped-twin: renders activation metadata already delivered by WORLD_INFO_ACTIVATED' }),
  gated('ui_panels', { surface: 'host_surface', id: 'portrait_dock.workspace', source: 'ui.portrait_dock', gatedBecause: 'Rule-B clause (c): creates a host-managed portrait panel surface' }),
  free({ surface: 'host_surface', id: 'lorebook.half.action', source: 'ui.lorebook_half_action', freeBecause: 'pure-host-action: emits a negotiated request to open the host workspace' }),
  gated('world_books', { surface: 'host_surface', id: 'lorebook.half.workspace', source: 'worldBooks.half_workspace', gatedBecause: 'Rule-B clause (d): hosts world-book workspace state and mutations' }),
  free({ surface: 'host_surface', id: 'lorebook.enhanced.action', source: 'ui.lorebook_enhanced_action', freeBecause: 'pure-host-action: emits a negotiated request to open the host workspace' }),
  gated('world_books', { surface: 'host_surface', id: 'lorebook.enhanced.workspace', source: 'worldBooks.enhanced_workspace', gatedBecause: 'Rule-B clause (d): hosts world-book workspace state and mutations' }),
]

const DOMAIN_ROWS: readonly AuthorityRow[] = [
  free({ surface: 'ctx_member', id: 'ctx.connections.list', source: 'connections.list', ctxLeaf: 'ctx.connections.list', freeBecause: 'rest: GET /api/v1/connections returns credential-redacted profiles for the authenticated session' }),
  free({ surface: 'ctx_member', id: 'ctx.connections.getActive', source: 'connections.active', ctxLeaf: 'ctx.connections.getActive', freeBecause: 'rest: GET /api/v1/connections returns the authenticated active-profile projection' }),
  free({ surface: 'ctx_member', id: 'ctx.connections.subscribe', source: 'connections.active', ctxLeaf: 'ctx.connections.subscribe', freeBecause: 'limb-e: subscription observes the same active-profile projection as ctx.connections.getActive' }),
  gated('generation', { surface: 'ctx_member', id: 'ctx.connections.models', source: 'connections.models', ctxLeaf: 'ctx.connections.models', gatedBecause: 'Rule-B clause (a): model lookup spends the stored provider credential on outbound egress' }),
  gated('generation', { surface: 'ctx_member', id: 'ctx.connections.setActive', source: 'connections.setActive', ctxLeaf: 'ctx.connections.setActive', gatedBecause: 'Rule-B clause (c): the store action persists generation-routing side effects' }),
  gated('generation', { surface: 'ctx_member', id: 'ctx.connections.update', source: 'connections.update', ctxLeaf: 'ctx.connections.update', gatedBecause: 'Rule-B clause (b): durable connection writes can set api_key credentials' }),
  free({ surface: 'ctx_member', id: 'ctx.chats.listForCharacter', source: 'chats.listForCharacter', ctxLeaf: 'ctx.chats.listForCharacter', freeBecause: 'rest: GET /api/v1/chats/character-chats/:id is session-authenticated' }),
  free({ surface: 'ctx_member', id: 'ctx.chats.getMessages', source: 'chats.messages', ctxLeaf: 'ctx.chats.getMessages', freeBecause: 'rest: GET /api/v1/chats/:id/messages is session-authenticated; the limit is a resource cap' }),
  free({ surface: 'ctx_member', id: 'ctx.chats.listRecent', source: 'chats.listRecent', ctxLeaf: 'ctx.chats.listRecent', freeBecause: 'rest: GET /api/v1/chats/recent is session-authenticated; the limit is a resource cap' }),
  free({ surface: 'ctx_member', id: 'ctx.chats.listRecentGrouped', source: 'chats.listRecentGrouped', ctxLeaf: 'ctx.chats.listRecentGrouped', freeBecause: 'rest: GET /api/v1/chats/recent-grouped is session-authenticated; the limit is a resource cap' }),
  gated('chats', { surface: 'ctx_member', id: 'ctx.chats.update', source: 'chats.update', ctxLeaf: 'ctx.chats.update', gatedBecause: 'Rule-B clause (b): durable chat write' }),
  gated('chats', { surface: 'ctx_member', id: 'ctx.chats.delete', source: 'chats.delete', ctxLeaf: 'ctx.chats.delete', gatedBecause: 'Rule-B clause (b): durable destructive chat write' }),
  free({ surface: 'ctx_member', id: 'ctx.worldBooks.list', source: 'worldBooks.list', ctxLeaf: 'ctx.worldBooks.list', freeBecause: 'rest: GET /api/v1/world-books is session-authenticated' }),
  free({ surface: 'ctx_member', id: 'ctx.worldBooks.entries', source: 'worldBooks.entries', ctxLeaf: 'ctx.worldBooks.entries', freeBecause: 'rest: GET /api/v1/world-books/:id/entries is session-authenticated' }),
  free({ surface: 'ctx_member', id: 'ctx.messages.getContent', source: 'messages.content', ctxLeaf: 'ctx.messages.getContent', freeBecause: 'limb-e: shipped ctx.messages.listMessageIds already enumerates the same shared message store' }),
  free({ surface: 'ctx_member', id: 'ctx.messages.getRecent', source: 'messages.recent', ctxLeaf: 'ctx.messages.getRecent', freeBecause: 'limb-e: shared message DOM and shipped message-id readers observe the same recent messages' }),
  ...(['countText', 'countMessages', 'countChat', 'countTextBatch'] as const).map((method) => free({
    surface: 'ctx_member' as const,
    id: `ctx.tokens.${method}`,
    source: `tokens.${method}`,
    ctxLeaf: `ctx.tokens.${method}`,
    freeBecause: 'rest: public authenticated tokenizer routes count bounded caller-supplied text without provider egress',
  })),
]

const GEOMETRY_ROWS: readonly AuthorityRow[] = [
  ...([
    'getUiScale',
    'toLayoutPx',
    'layoutViewportSize',
    'layoutElementRect',
    'createResizeController',
  ] as const).map((method) => free({
    surface: 'ctx_member' as const,
    id: `ctx.ui.geometry.${method}`,
    source: 'ui.geometry',
    ctxLeaf: `ctx.ui.geometry.${method}`,
    freeBecause: 'limb-e: pure layout-scale, viewport, rectangle, and resize-controller observation has no host entity or credential side effect',
  })),
]

const LEGACY_ROWS: readonly AuthorityRow[] = [
  free({ surface: 'legacy_ctx_member', id: 'ctx.characters.get', source: 'characters.get', ctxLeaf: 'ctx.characters.get', freeBecause: 'rest: GET /api/v1/characters/:id is session-authenticated' }),
  gated('chats', { surface: 'legacy_ctx_member', id: 'ctx.chats.updateMessage', source: 'chats.message.update', ctxLeaf: 'ctx.chats.updateMessage', gatedBecause: 'Rule-B clause (b): durable message mutation' }),
  ...(['getLatestMessageId', 'getMessageIdAtIndex', 'listMessageIds'] as const).map((method) => free({ surface: 'legacy_ctx_member' as const, id: `ctx.messages.${method}`, source: 'messages.ids', ctxLeaf: `ctx.messages.${method}`, freeBecause: 'limb-e: message ids and order are observable in the shared message DOM' })),
  ...(['getDrawerState', 'onDrawerChange'] as const).map((method) => free({ surface: 'legacy_ctx_member' as const, id: `ctx.ui.events.${method}`, source: 'ui.drawer', ctxLeaf: `ctx.ui.events.${method}`, freeBecause: 'limb-e: shipped drawer-state helper is the same observation' })),
  ...(['getSettingsState', 'onSettingsChange'] as const).map((method) => free({ surface: 'legacy_ctx_member' as const, id: `ctx.ui.events.${method}`, source: 'ui.settings', ctxLeaf: `ctx.ui.events.${method}`, freeBecause: 'limb-e: shipped settings-state helper is the same observation' })),
  free({ surface: 'legacy_ctx_member', id: 'ctx.getActiveChat', source: 'chat.active', ctxLeaf: 'ctx.getActiveChat', freeBecause: 'limb-e: shipped ctx.getActiveChat exposes the active chat and character ids' }),
  ...(['registerCharacterEditorTab', 'characterEditor.getState', 'characterEditor.onChange', 'characterEditor.setExtensions', 'characterEditor.updateExtensions', 'characterEditor.flush'] as const).map((member) => gated('characters', { surface: 'legacy_ctx_member' as const, id: `ctx.ui.${member}`, source: 'characters.editingId', ctxLeaf: `ctx.ui.${member}`, gatedBecause: 'Rule-B clause (d): exposes or mutates the active character-editor entity' })),
  ...(['registerConnectionEditorTab', 'connectionEditor.getEditedProfileId', 'connectionEditor.getState', 'connectionEditor.onChange', 'connectionEditor.onSaved'] as const).map((member) => gated('generation', { surface: 'legacy_ctx_member' as const, id: `ctx.ui.${member}`, source: 'connections.editor', ctxLeaf: `ctx.ui.${member}`, gatedBecause: 'Rule-B clause (d): exposes the transient connection editor and its save lifecycle' })),
  ...(['registerPresetEditorTab', 'registerPresetEditorToolbarItem', 'presetEditor.extension', 'presetEditor.getState', 'presetEditor.onChange', 'presetEditor.updatePreset', 'presetEditor.flush'] as const).map((member) => gated('presets', { surface: 'legacy_ctx_member' as const, id: `ctx.ui.${member}`, source: 'presets.editor', ctxLeaf: `ctx.ui.${member}`, gatedBecause: 'Rule-B clause (d): exposes or mutates protected preset-editor state' })),
  gated('ui_panels', { surface: 'legacy_ctx_member', id: 'ctx.ui.createFloatWidget', source: 'ui.floatWidget', ctxLeaf: 'ctx.ui.createFloatWidget', gatedBecause: 'Rule-B clause (c): creates a host-managed floating UI surface' }),
  gated('ui_panels', { surface: 'legacy_ctx_member', id: 'ctx.ui.requestDockPanel', source: 'ui.dockPanel', ctxLeaf: 'ctx.ui.requestDockPanel', gatedBecause: 'Rule-B clause (c): creates a host-managed dock panel' }),
  gated('ui_panels', { surface: 'legacy_ctx_member', id: 'ctx.ui.getBuiltInTabRoot', source: 'ui.builtInTabRoot', ctxLeaf: 'ctx.ui.getBuiltInTabRoot', gatedBecause: 'Rule-B clause (d): exposes a host-managed built-in tab root' }),
  gated('app_manipulation', { surface: 'legacy_ctx_member', id: 'ctx.ui.mountApp', source: 'ui.mountApp', ctxLeaf: 'ctx.ui.mountApp', gatedBecause: 'Rule-B clause (c): mounts an app-level host surface' }),
  gated('app_manipulation|ui_panels', { surface: 'legacy_ctx_member', id: 'ctx.ui.requestTabLocation', source: 'ui.requestTabLocation', ctxLeaf: 'ctx.ui.requestTabLocation', gatedBecause: 'Rule-B clause (c): changes placement in a host-managed tab surface' }),
]

const THEME_AUTHORING_ROWS: readonly AuthorityRow[] = [
  free({ surface: 'ctx_member', id: 'ctx.theme.assets.getActiveBundleId', source: 'theme.assets.activeBundleId', ctxLeaf: 'ctx.theme.assets.getActiveBundleId', freeBecause: 'rest: exposes only the active user-scoped theme asset bundle identifier' }),
  free({ surface: 'ctx_member', id: 'ctx.theme.assets.createBundle', source: 'theme.assets.bundleId', ctxLeaf: 'ctx.theme.assets.createBundle', freeBecause: 'pure-host-action: generates an inert bundle UUID without persisting host state' }),
  free({ surface: 'ctx_member', id: 'ctx.theme.assets.list', source: 'theme.assets.read', ctxLeaf: 'ctx.theme.assets.list', freeBecause: 'rest: returns the authenticated user-scoped theme asset projection' }),
  free({ surface: 'ctx_member', id: 'ctx.theme.assets.getBytes', source: 'theme.assets.read', ctxLeaf: 'ctx.theme.assets.getBytes', freeBecause: 'rest: returns authenticated bytes for an existing user-scoped theme asset' }),
  gated('app_manipulation', { surface: 'ctx_member', id: 'ctx.theme.assets.upload', source: 'theme.assets.upload', ctxLeaf: 'ctx.theme.assets.upload', gatedBecause: 'Rule-B clause (b): persists a new native theme asset' }),
  gated('app_manipulation', { surface: 'ctx_member', id: 'ctx.theme.assets.update', source: 'theme.assets.update', ctxLeaf: 'ctx.theme.assets.update', gatedBecause: 'Rule-B clause (b): mutates durable native theme asset metadata' }),
  gated('app_manipulation', { surface: 'ctx_member', id: 'ctx.theme.assets.delete', source: 'theme.assets.delete', ctxLeaf: 'ctx.theme.assets.delete', gatedBecause: 'Rule-B clause (b): destructively removes a durable native theme asset' }),
  gated('app_manipulation', { surface: 'ctx_member', id: 'ctx.theme.assets.optimizeWebp', source: 'theme.assets.optimizeWebp', ctxLeaf: 'ctx.theme.assets.optimizeWebp', gatedBecause: 'Rule-B clause (b): replaces durable native theme asset content' }),
  free({ surface: 'ctx_member', id: 'ctx.theme.packs.exportDraft', source: 'theme.packs.export', ctxLeaf: 'ctx.theme.packs.exportDraft', freeBecause: 'pure-host-action: snapshots user-scoped assets and encodes bytes without mutating host state' }),
  gated('app_manipulation', { surface: 'ctx_member', id: 'ctx.theme.packs.importArchive', source: 'theme.packs.import', ctxLeaf: 'ctx.theme.packs.importArchive', gatedBecause: 'Rule-B clause (b): imports archive assets into a durable native bundle' }),
  gated('app_manipulation', { surface: 'ctx_member', id: 'ctx.theme.packs.installDraft', source: 'theme.packs.install', ctxLeaf: 'ctx.theme.packs.installDraft', gatedBecause: 'Rule-B clause (b): installs and optionally saves durable native theme state' }),
  free({ surface: 'ctx_member', id: 'ctx.theme.catalog.listComponents', source: 'theme.catalog.components', ctxLeaf: 'ctx.theme.catalog.listComponents', freeBecause: 'shipped-twin: returns the sanitized component inventory already exposed by the native Theme Editor' }),
  free({ surface: 'ctx_member', id: 'ctx.theme.catalog.listVariables', source: 'theme.catalog.variables', ctxLeaf: 'ctx.theme.catalog.listVariables', freeBecause: 'shipped-twin: returns the CSS variable reference already exposed by the native Theme Editor' }),
  free({ surface: 'ctx_member', id: 'ctx.theme.openEditor', source: 'theme.editor.navigation', ctxLeaf: 'ctx.theme.openEditor', freeBecause: 'pure-host-action: opens and focuses an allowlisted native Theme Editor location' }),
]

export const FRONTEND_AUTHORITY_MAP: readonly AuthorityRow[] = createAuthorityMap([
  ...SELECTOR_ROWS,
  ...settingsAuthorityRows(),
  ...DOMAIN_ROWS,
  ...GEOMETRY_ROWS,
  ...HOST_ACTION_ROWS,
  ...HOST_SURFACE_ROWS,
  ...THEME_AUTHORING_ROWS,
  ...LEGACY_ROWS,
])

function createAuthorityMap(rows: readonly AuthorityRow[]): readonly AuthorityRow[] {
  const ids = new Set<string>()
  const permissionsBySource = new Map<string, string | null>()
  for (const row of rows) {
    const key = `${row.surface}:${row.id}`
    if (ids.has(key)) throw new Error(`Duplicate frontend authority row: ${key}`)
    ids.add(key)
    if (row.permission === null && (!row.freeBecause || row.gatedBecause)) throw new Error(`Invalid frontend authority rationale: ${key}`)
    if (row.permission !== null && (!row.gatedBecause || row.freeBecause)) throw new Error(`Invalid frontend authority rationale: ${key}`)
    if (row.grandfathered !== undefined) throw new Error(`Grandfathered frontend authority rows are forbidden: ${key}`)
    const previous = permissionsBySource.get(row.source)
    if (previous !== undefined && previous !== row.permission) throw new Error(`Conflicting frontend authority permissions for source: ${row.source}`)
    permissionsBySource.set(row.source, row.permission)
  }
  return Object.freeze([...rows])
}

const rowsByReference = new Map<string, AuthorityRow>(
  FRONTEND_AUTHORITY_MAP.map((row) => [`${row.surface}:${row.id}`, row]),
)

export interface FrontendAuthorityReference {
  surface: FrontendAuthoritySurface
  id: string
}

export function frontendAuthorityRowFor(reference: FrontendAuthorityReference): AuthorityRow | undefined {
  const exact = rowsByReference.get(`${reference.surface}:${reference.id}`)
  if (exact) return exact
  if (reference.surface !== 'host_action') return undefined

  // Extension-owned ids are intentionally dynamic. They are accepted only in
  // the shapes produced by the placement/command registries; arbitrary
  // `command:*` ids do not get a free default.
  if (reference.id.startsWith('drawer_tab:')) {
    return free({
      surface: 'host_action',
      id: reference.id,
      source: `ui.openDrawer:${reference.id.slice('drawer_tab:'.length)}`,
      freeBecause: 'pure-host-action: opens an extension-owned drawer tab registered by the host',
    })
  }
  if (reference.id.startsWith('settings_tab:')) {
    return free({
      surface: 'host_action',
      id: reference.id,
      source: `ui.openSettings:${reference.id.slice('settings_tab:'.length)}`,
      freeBecause: 'pure-host-action: opens a role-filtered extension settings tab registered by the host',
    })
  }
  if (reference.id.startsWith('command:ext-tab-')) {
    return free({
      surface: 'host_action',
      id: reference.id,
      source: `ui.openDrawer:${reference.id.slice('command:ext-tab-'.length)}`,
      freeBecause: 'pure-host-action: opens an extension-owned drawer tab through the host command catalog',
    })
  }
  if (reference.id.startsWith('ext_command:ext-cmd-')) {
    return gated('app_manipulation', {
      surface: 'host_action',
      id: reference.id,
      source: 'ui.extCommand.crossExtension',
      gatedBecause: 'Rule-B clause (c): invokes another extension backend under its owner boundary',
    })
  }
  return undefined
}

export function frontendAuthorityRow(surface: FrontendAuthoritySurface, id: string): AuthorityRow {
  const row = frontendAuthorityRowFor({ surface, id })
  if (!row) throw new Error(`FRONTEND_AUTHORITY_UNKNOWN:${surface}:${id}`)
  return row
}

export function frontendAuthorityPermission(surface: FrontendAuthoritySurface, id: string): string | null {
  return frontendAuthorityRow(surface, id).permission
}

/** Direct callable/accessor ctx leaves projected from the canonical map. */
export const CTX_AUTHORITY_MEMBERS: readonly AuthorityRow[] = projectCtxAuthorityMembers(FRONTEND_AUTHORITY_MAP)

export function projectCtxAuthorityMembers(rows: readonly AuthorityRow[]): readonly AuthorityRow[] {
  const byLeaf = new Map<string, AuthorityRow>()
  for (const row of rows) {
    if ((row.surface !== 'ctx_member' && row.surface !== 'legacy_ctx_member') || !row.ctxLeaf) continue
    const existing = byLeaf.get(row.ctxLeaf)
    if (existing && existing.permission !== row.permission) throw new Error(`Conflicting frontend authority permissions for ctx leaf: ${row.ctxLeaf}`)
    byLeaf.set(row.ctxLeaf, row)
  }
  return Object.freeze([...byLeaf.values()])
}
