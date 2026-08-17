import { sanitizeRichHtml } from '@/lib/richHtmlSanitizer'
import {
  bindSpindleExtensionDiagnosticsGetter,
  type SpindleExtensionCounters,
} from './extension-diagnostics'
import {
  EXTENSION_ROOT_ATTRIBUTES,
  stampExtensionRoot,
} from './extension-root-stamp'

export const DATA_SPINDLE_MOUNT_ATTR = 'data-spindle-mount'
export const DATA_SPINDLE_SCOPE_ATTR = 'data-spindle-scope'
export const DATA_SPINDLE_OWNER_ATTR = 'data-spindle-owner'
export const DATA_SPINDLE_GENERATION_ATTR = 'data-spindle-generation'

export type MountCardinality = 'S' | 'R'
export type DecoratorKind = 'html' | 'svg' | 'badge' | 'button' | 'context-action'

export interface CanonicalMountRecord {
  literal: string
  hostFiles: readonly string[]
  region: string
  cardinality: MountCardinality
  scopeTemplate: string
}

export interface PhysicalMountPlacement {
  literal: string
  hostFile: string
  hostName: string
  region: string
  cardinality: MountCardinality
  scopeTemplate: string
  placementId: string
}

export interface ExistingFrontendMountStamp {
  literal: string
  file: string
  legacy: boolean
}

export interface AnchorRegistration {
  mount: string
  scope: string
  liveAnchorId: string
  owner: string
  generation: number
  node: Element
  instanceKey?: string
}

export interface AnchorRegistrationInput {
  mount: string
  scope: string
  owner: string
  generation: number
  node: Element
  instanceKey?: string
}

export interface DecoratorRenderContext {
  mount: string
  scope: string
  liveAnchorId: string
  owner: string
  generation: number
  node: Element
  root: HTMLElement
}

export interface DecoratorOptions {
  mount: string
  owner: string
  generation: number
  render?: (root: HTMLElement, ctx: DecoratorRenderContext) => void | (() => void)
  update?: (root: HTMLElement, ctx: DecoratorRenderContext) => void
  priority?: number
  instanceKey?: string
  kind?: DecoratorKind
  html?: string
  svg?: string
}

export interface DomDecoratorService {
  registerAnchor(input: AnchorRegistrationInput): AnchorRegistration
  unregisterAnchor(nodeOrId: Element | string): void
  registerDecorator(options: DecoratorOptions): () => void
  inject(input: {
    owner: string
    generation: number
    mount: string
    scope: string
    html?: string
    svg?: string
    kind?: DecoratorKind
  }): HTMLElement | null
  replay(node?: Element): void
  detachPortal(node: Element): void
  unloadGeneration(owner: string, generation: number): void
  ensureLegacyObserver(): void
  scanLegacyHosts(): void
  flush(): void
  getRoot(owner: string, generation: number, mount: string, scope: string, liveAnchorId?: string): HTMLElement | null
  getRegistration(node: Element): AnchorRegistration | null
  getCounters(owner: string, generation: number): SpindleExtensionCounters
}

interface DecoratorRecord {
  id: string
  options: DecoratorOptions
  disposed: boolean
}

interface RootRecord {
  root: HTMLElement
  identityKey: string
  liveAnchorId: string
  owner: string
  generation: number
  mount: string
  scope: string
  injected: Map<string, HTMLElement>
  disposers: Map<string, () => void>
}

interface PendingWork {
  teardowns: Array<() => void>
  mounts: Array<() => void>
}

const FORGED_OWNERSHIP_ATTRS = [...EXTENSION_ROOT_ATTRIBUTES]

export const CANONICAL_MOUNT_PLACEMENTS: readonly CanonicalMountRecord[] = [
  { literal: 'chat_header_left', hostFiles: ['frontend/src/components/chat/ChatView.tsx'], region: 'ChatView chrome, first child of chatColumnTopRef', cardinality: 'S', scopeTemplate: 'chat:${chatId}:header-left' },
  { literal: 'chat_header_center', hostFiles: ['frontend/src/components/chat/ChatView.tsx'], region: 'ChatView chrome, centered child of chatColumnTopRef', cardinality: 'S', scopeTemplate: 'chat:${chatId}:header-center' },
  { literal: 'chat_header_right', hostFiles: ['frontend/src/components/chat/ChatView.tsx'], region: 'ChatView chrome, trailing child of chatColumnTopRef', cardinality: 'S', scopeTemplate: 'chat:${chatId}:header-right' },
  { literal: 'chat_top_dock', hostFiles: ['frontend/src/components/chat/ChatView.tsx'], region: 'existing chatTopDockRef dock container', cardinality: 'S', scopeTemplate: 'chat:${chatId}:top-dock' },
  { literal: 'chat_bottom_dock', hostFiles: ['frontend/src/components/chat/ChatView.tsx'], region: 'chat column directly after MessageList', cardinality: 'S', scopeTemplate: 'chat:${chatId}:bottom-dock' },
  { literal: 'chat_surface_side', hostFiles: ['frontend/src/components/chat/ChatView.tsx'], region: 'sibling beside chat column before PortraitPanel', cardinality: 'S', scopeTemplate: 'chat:${chatId}:surface-side' },
  { literal: 'chat_sidebar_left', hostFiles: ['frontend/src/components/chat/ChatView.tsx'], region: 'left side surface in ChatView body', cardinality: 'S', scopeTemplate: 'chat:${chatId}:sidebar-left' },
  { literal: 'chat_sidebar_right', hostFiles: ['frontend/src/components/chat/ChatView.tsx'], region: 'right side surface in ChatView body', cardinality: 'S', scopeTemplate: 'chat:${chatId}:sidebar-right' },
  { literal: 'chat_stream_before', hostFiles: ['frontend/src/components/chat/MessageList.tsx'], region: 'first child inside [data-chat-scroll=true]', cardinality: 'S', scopeTemplate: 'chat:${chatId}:stream-before' },
  { literal: 'chat_stream_after', hostFiles: ['frontend/src/components/chat/MessageList.tsx'], region: 'final child inside [data-chat-scroll=true]', cardinality: 'S', scopeTemplate: 'chat:${chatId}:stream-after' },
  { literal: 'chat_empty_state', hostFiles: ['frontend/src/components/chat/MessageList.tsx'], region: 'empty-range branch before message rows', cardinality: 'S', scopeTemplate: 'chat:${chatId}:empty' },
  { literal: 'chat_composer_above', hostFiles: ['frontend/src/components/chat/InputArea.tsx'], region: 'first child of InputArea container', cardinality: 'S', scopeTemplate: 'chat:${chatId}:composer-above' },
  { literal: 'chat_composer_below', hostFiles: ['frontend/src/components/chat/InputArea.tsx'], region: 'final child of InputArea container', cardinality: 'S', scopeTemplate: 'chat:${chatId}:composer-below' },
  { literal: 'chat_input_tools_left', hostFiles: ['frontend/src/components/chat/InputArea.tsx'], region: 'input-bar tools row before native leading tools', cardinality: 'S', scopeTemplate: 'chat:${chatId}:input-tools-left' },
  { literal: 'chat_input_tools_right', hostFiles: ['frontend/src/components/chat/InputArea.tsx'], region: 'input-bar tools row after native trailing tools', cardinality: 'S', scopeTemplate: 'chat:${chatId}:input-tools-right' },
  { literal: 'chat_actions', hostFiles: ['frontend/src/components/chat/InputArea.tsx'], region: 'action-bar container adjacent to native send controls', cardinality: 'S', scopeTemplate: 'chat:${chatId}:actions' },
  { literal: 'chat_toolbar', hostFiles: ['frontend/src/components/chat/InputArea.tsx'], region: 'toolbar row following the composer action bar', cardinality: 'S', scopeTemplate: 'chat:${chatId}:toolbar' },
  { literal: 'message_header', hostFiles: ['frontend/src/components/chat/BubbleMessageDefault.tsx', 'frontend/src/components/chat/MinimalMessageDefault.tsx'], region: 'first child of each message .header', cardinality: 'R', scopeTemplate: 'message:${message.id}:header' },
  { literal: 'message_body_before', hostFiles: ['frontend/src/components/chat/BubbleMessageDefault.tsx', 'frontend/src/components/chat/MinimalMessageDefault.tsx'], region: 'immediately before MessageContent', cardinality: 'R', scopeTemplate: 'message:${message.id}:body-before' },
  { literal: 'message_body_after', hostFiles: ['frontend/src/components/chat/BubbleMessageDefault.tsx', 'frontend/src/components/chat/MinimalMessageDefault.tsx'], region: 'immediately after MessageContent', cardinality: 'R', scopeTemplate: 'message:${message.id}:body-after' },
  { literal: 'message_footer', hostFiles: ['frontend/src/components/chat/BubbleMessageDefault.tsx', 'frontend/src/components/chat/MinimalMessageDefault.tsx'], region: 'final child of each message card', cardinality: 'R', scopeTemplate: 'message:${message.id}:footer' },
  { literal: 'message_actions', hostFiles: ['frontend/src/components/chat/BubbleActions.tsx'], region: 'trailing child of BubbleActions pill', cardinality: 'R', scopeTemplate: 'message:${messageId}:actions' },
  { literal: 'message_edit_actions', hostFiles: ['frontend/src/components/chat/MessageEditArea.tsx'], region: 'save/cancel action row after native buttons', cardinality: 'R', scopeTemplate: 'message:${messageId}:edit-actions' },
  { literal: 'message_context_menu', hostFiles: ['frontend/src/components/chat/MessageList.tsx'], region: 'keyed message-row context-menu portal owner', cardinality: 'R', scopeTemplate: 'message:${messageId}:context-menu' },
  { literal: 'message_swipe_indicators', hostFiles: ['frontend/src/components/chat/BubbleMessageDefault.tsx', 'frontend/src/components/chat/MinimalMessageDefault.tsx'], region: 'swipe indicator region beside native swipe controls', cardinality: 'R', scopeTemplate: 'message:${message.id}:swipe-indicators' },
  { literal: 'landing_header', hostFiles: ['frontend/src/components/landing/LandingPage.tsx'], region: 'LandingPageHeader header, before native actions', cardinality: 'S', scopeTemplate: 'landing:header' },
  { literal: 'landing_hero', hostFiles: ['frontend/src/components/landing/LandingPage.tsx'], region: 'first child of LandingPageMain', cardinality: 'S', scopeTemplate: 'landing:hero' },
  { literal: 'landing_characters', hostFiles: ['frontend/src/components/landing/LandingPage.tsx'], region: 'existing LandingPageCharacterPanel region', cardinality: 'S', scopeTemplate: 'landing:characters' },
  { literal: 'landing_recent_chats', hostFiles: ['frontend/src/components/landing/LandingPage.tsx'], region: 'LandingPageChats region', cardinality: 'S', scopeTemplate: 'landing:recent-chats' },
  { literal: 'landing_footer', hostFiles: ['frontend/src/components/landing/LandingPage.tsx'], region: 'final child of landing container', cardinality: 'S', scopeTemplate: 'landing:footer' },
  { literal: 'sidebar_top', hostFiles: ['frontend/src/components/panels/ViewportDrawer.tsx'], region: 'first child inside existing sidebar mount', cardinality: 'S', scopeTemplate: 'drawer:sidebar-top' },
  { literal: 'sidebar_bottom', hostFiles: ['frontend/src/components/panels/ViewportDrawer.tsx'], region: 'sidebarBottom before native bottom controls', cardinality: 'S', scopeTemplate: 'drawer:sidebar-bottom' },
  { literal: 'drawer_tab', hostFiles: ['frontend/src/components/panels/ViewportDrawer.tsx'], region: 'each mapped sidebar tab after native icon', cardinality: 'R', scopeTemplate: 'drawer-tab:${tab.id}' },
  { literal: 'drawer_header_actions', hostFiles: ['frontend/src/components/panels/ViewportDrawer.tsx'], region: 'drawer header action cluster', cardinality: 'S', scopeTemplate: 'drawer:header-actions' },
  { literal: 'drawer_footer', hostFiles: ['frontend/src/components/panels/ViewportDrawer.tsx'], region: 'final drawer child below sidebar', cardinality: 'S', scopeTemplate: 'drawer:footer' },
  { literal: 'character_editor_tab', hostFiles: ['frontend/src/components/panels/character-browser/CharacterEditorPage.tsx'], region: 'editor tab strip after native tabs', cardinality: 'S', scopeTemplate: 'character-editor:${characterId}:tab' },
  { literal: 'character_browser_card_actions', hostFiles: ['frontend/src/components/panels/character-browser/CharacterCard.tsx'], region: 'card action cluster after native actions', cardinality: 'R', scopeTemplate: 'character-card:${character.id}:actions' },
  { literal: 'preset_editor_tab', hostFiles: ['frontend/src/components/panels/LoomBuilder.tsx'], region: 'preset editor tab strip after native tabs', cardinality: 'S', scopeTemplate: 'loom:${presetId}:preset-tab' },
  { literal: 'preset_editor_toolbar', hostFiles: ['frontend/src/components/panels/LoomBuilder.tsx'], region: 'preset-editor toolbar after native controls', cardinality: 'S', scopeTemplate: 'loom:${presetId}:preset-toolbar' },
  { literal: 'persona_editor_tab', hostFiles: ['frontend/src/components/panels/persona-browser/PersonaEditor.tsx'], region: 'persona editor tab/action strip after native controls', cardinality: 'S', scopeTemplate: 'persona-editor:${personaId}:tab' },
  { literal: 'world_book_entry_table', hostFiles: ['frontend/src/components/world-book-editor/EntryTable.tsx'], region: 'table container before entry rows', cardinality: 'S', scopeTemplate: 'world-book:${bookId}:entry-table' },
  { literal: 'world_book_entry_row', hostFiles: ['frontend/src/components/world-book-editor/EntryTable.tsx'], region: 'each keyed entry row after row controls', cardinality: 'R', scopeTemplate: 'world-book-entry:${entry.id}:row' },
  { literal: 'world_book_entry_editor', hostFiles: ['frontend/src/components/shared/WorldBookEntryEditor.tsx'], region: 'editor form before field body', cardinality: 'S', scopeTemplate: 'world-book-entry:${entryId}:editor' },
  { literal: 'world_book_entry_toolbar', hostFiles: ['frontend/src/components/shared/WorldBookEntryEditor.tsx'], region: 'entry editor toolbar after native actions', cardinality: 'S', scopeTemplate: 'world-book-entry:${entryId}:toolbar' },
  { literal: 'lorebook_workspace', hostFiles: ['frontend/src/components/world-book-editor/LorebookEditorWorkspace.tsx'], region: 'workspace root after header', cardinality: 'S', scopeTemplate: 'lorebook:${bookId}:workspace' },
  { literal: 'lorebook_half_workspace', hostFiles: ['frontend/src/components/chat/ChatView.tsx'], region: 'half-workspace surface beside chat column', cardinality: 'S', scopeTemplate: 'chat:${chatId}:lorebook-half' },
  { literal: 'loom_builder_toolbar', hostFiles: ['frontend/src/components/panels/LoomBuilder.tsx'], region: 'main LoomBuilder toolbar after native controls', cardinality: 'S', scopeTemplate: 'loom:${presetId}:builder-toolbar' },
  { literal: 'loom_builder_inspector', hostFiles: ['frontend/src/components/panels/LoomBuilder.tsx'], region: 'inspector pane before native inspector content', cardinality: 'S', scopeTemplate: 'loom:${presetId}:inspector' },
  { literal: 'regex_entry_row', hostFiles: ['frontend/src/components/panels/RegexPanel.tsx'], region: 'each keyed regex entry row after native controls', cardinality: 'R', scopeTemplate: 'regex-entry:${entry.id}:row' },
  { literal: 'settings_tab', hostFiles: ['frontend/src/components/modals/SettingsModal.tsx'], region: 'sidebar dynamic-tab list after registered native tabs', cardinality: 'R', scopeTemplate: 'settings-tab:${tab.id}' },
  { literal: 'settings_section', hostFiles: ['frontend/src/components/modals/SettingsModal.tsx', 'frontend/src/components/settings/ProductivitySettings.tsx'], region: 'active settings content and each ProductivitySettings card boundary', cardinality: 'R', scopeTemplate: 'settings-section:${activeTabId}:${sectionId}' },
  { literal: 'settings_card_actions', hostFiles: ['frontend/src/components/settings/ProductivitySettings.tsx'], region: 'CardHeader cardHeaderAction after native action', cardinality: 'R', scopeTemplate: 'settings-card:${cardId}:actions' },
  { literal: 'settings_extensions', hostFiles: ['frontend/src/components/modals/SettingsModal.tsx'], region: 'active content extension-section container', cardinality: 'S', scopeTemplate: 'settings:extensions:${activeTabId}' },
  { literal: 'modal_header_actions', hostFiles: ['frontend/src/components/shared/ModalShell.tsx'], region: 'ModalShell header action cluster after native close control', cardinality: 'S', scopeTemplate: 'modal:${modalId}:header-actions' },
  { literal: 'modal_footer_actions', hostFiles: ['frontend/src/components/shared/ModalShell.tsx'], region: 'ModalShell footer action cluster after native actions', cardinality: 'S', scopeTemplate: 'modal:${modalId}:footer-actions' },
  { literal: 'command_palette_actions', hostFiles: ['frontend/src/components/modals/CommandPalette.tsx'], region: 'command-palette footer before shortcut hints', cardinality: 'S', scopeTemplate: 'command-palette:actions' },
  { literal: 'manage_chats_actions', hostFiles: ['frontend/src/components/modals/ManageChatsModal.tsx'], region: 'header toolbar after native bulk/manage buttons', cardinality: 'S', scopeTemplate: 'manage-chats:${characterId}:actions' },
  { literal: 'prompt_variables_toolbar', hostFiles: ['frontend/src/components/shared/PromptVariablesModal.tsx'], region: 'PromptVariablesModal header after title/subtitle', cardinality: 'S', scopeTemplate: 'prompt-variables:${presetId}:toolbar' },
]

const SHARED_PHYSICAL_PLACEMENTS: Record<string, readonly PhysicalMountPlacement[]> = {
  message_header: [
    physicalPlacement('message_header', 'frontend/src/components/chat/BubbleMessageDefault.tsx', 'BubbleMessageDefault', 'inside <div className={styles.header}>, immediately after native <div className={styles.headerLeft}> (avatar/name/MetaPill)', 'R', 'message:${message.id}:bubble:header'),
    physicalPlacement('message_header', 'frontend/src/components/chat/MinimalMessageDefault.tsx', 'MinimalMessageDefault', 'inside <div className={styles.header}>, immediately after native MetaPill', 'R', 'message:${message.id}:minimal:header'),
  ],
  message_body_before: [
    physicalPlacement('message_body_before', 'frontend/src/components/chat/BubbleMessageDefault.tsx', 'BubbleMessageDefault', 'inside the native <div className={styles.content}>, immediately before the {isEditing ? ... : displayContent ? <MessageContent ...>} branch', 'R', 'message:${message.id}:bubble:body-before'),
    physicalPlacement('message_body_before', 'frontend/src/components/chat/MinimalMessageDefault.tsx', 'MinimalMessageDefault', 'immediately before the native {isEditing ? ... : displayContent ? <MessageContent ...>} branch', 'R', 'message:${message.id}:minimal:body-before'),
  ],
  message_body_after: [
    physicalPlacement('message_body_after', 'frontend/src/components/chat/BubbleMessageDefault.tsx', 'BubbleMessageDefault', 'immediately after the native content <div className={styles.content}> and before the user-attachment conditional', 'R', 'message:${message.id}:bubble:body-after'),
    physicalPlacement('message_body_after', 'frontend/src/components/chat/MinimalMessageDefault.tsx', 'MinimalMessageDefault', 'immediately after the native {isEditing ? ... : displayContent ? <MessageContent ...>} branch and before the user-attachment conditional', 'R', 'message:${message.id}:minimal:body-after'),
  ],
  message_footer: [
    physicalPlacement('message_footer', 'frontend/src/components/chat/BubbleMessageDefault.tsx', 'BubbleMessageDefault', 'inside <div className={styles.bubble}>, immediately after the SwipeControls/GreetingNav conditionals and before the sibling BubbleActions block', 'R', 'message:${message.id}:bubble:footer'),
    physicalPlacement('message_footer', 'frontend/src/components/chat/MinimalMessageDefault.tsx', 'MinimalMessageDefault', 'inside <div className={styles.bubble}>, immediately after the SwipeControls/GreetingNav conditionals and before the sibling actionsWrap/MessageActions block', 'R', 'message:${message.id}:minimal:footer'),
  ],
  message_swipe_indicators: [
    physicalPlacement('message_swipe_indicators', 'frontend/src/components/chat/BubbleMessageDefault.tsx', 'BubbleMessageDefault', 'inside <div className={styles.bubble}>, immediately after the native SwipeControls conditional and before the GreetingNav conditional', 'R', 'message:${message.id}:bubble:swipe-indicators'),
    physicalPlacement('message_swipe_indicators', 'frontend/src/components/chat/MinimalMessageDefault.tsx', 'MinimalMessageDefault', 'inside <div className={styles.bubble}>, immediately after the native SwipeControls conditional and before the GreetingNav conditional', 'R', 'message:${message.id}:minimal:swipe-indicators'),
  ],
  settings_section: [
    physicalPlacement('settings_section', 'frontend/src/components/modals/SettingsModal.tsx', 'SettingsModal', 'active SettingsModal settings-content boundary immediately after the selected tab heading and before native section content', 'R', 'settings-section:${activeTabId}:modal'),
    physicalPlacement('settings_section', 'frontend/src/components/settings/ProductivitySettings.tsx', 'ProductivitySettings', 'each keyed ProductivitySettings card boundary immediately after the card heading and before native card content', 'R', 'settings-section:productivity:${cardId}'),
  ],
}

export const PHYSICAL_MOUNT_PLACEMENTS: readonly PhysicalMountPlacement[] = CANONICAL_MOUNT_PLACEMENTS.flatMap((record) => {
  const shared = SHARED_PHYSICAL_PLACEMENTS[record.literal]
  if (shared) return [...shared]
  const hostFile = record.hostFiles[0]
  return [physicalPlacement(record.literal, hostFile, hostNameFromFile(hostFile), record.region, record.cardinality, record.scopeTemplate)]
})

export const EXISTING_FRONTEND_MOUNT_STAMPS: readonly ExistingFrontendMountStamp[] = [
  { literal: 'chat_column_top', file: 'frontend/src/components/chat/ChatView.tsx', legacy: true },
  { literal: 'chat_top_dock', file: 'frontend/src/components/chat/ChatView.tsx', legacy: false },
  { literal: 'chat_bottom_dock', file: 'frontend/src/components/chat/ChatView.tsx', legacy: false },
  { literal: 'lorebook_half_workspace', file: 'frontend/src/components/chat/ChatView.tsx', legacy: false },
  { literal: 'chat_surface_side', file: 'frontend/src/components/chat/ChatView.tsx', legacy: false },
  { literal: 'chat_composer_above', file: 'frontend/src/components/chat/InputArea.tsx', legacy: false },
  { literal: 'chat_toolbar', file: 'frontend/src/components/chat/InputArea.tsx', legacy: false },
  { literal: 'chat_actions', file: 'frontend/src/components/chat/InputArea.tsx', legacy: false },
  { literal: 'message_footer', file: 'frontend/src/components/chat/MessageList.tsx', legacy: false },
  { literal: 'landing_toolbar', file: 'frontend/src/components/landing/LandingPage.tsx', legacy: true },
  { literal: 'landing_main', file: 'frontend/src/components/landing/LandingPage.tsx', legacy: true },
  { literal: 'landing_characters', file: 'frontend/src/components/landing/LandingPage.tsx', legacy: false },
  { literal: 'settings_extensions', file: 'frontend/src/components/modals/SettingsModal.tsx', legacy: false },
  { literal: 'sidebar', file: 'frontend/src/components/panels/ViewportDrawer.tsx', legacy: true },
]

function physicalPlacement(
  literal: string,
  hostFile: string,
  hostName: string,
  region: string,
  cardinality: MountCardinality,
  scopeTemplate: string,
): PhysicalMountPlacement {
  return {
    literal,
    hostFile,
    hostName,
    region,
    cardinality,
    scopeTemplate,
    placementId: `${literal}:${hostName}`,
  }
}

function hostNameFromFile(hostFile: string): string {
  const file = hostFile.split('/').pop() ?? hostFile
  return file.replace(/\.(tsx|ts)$/, '')
}

export function createSpindleMountHost(options: {
  mount: string
  scope: string
  owner?: string
  generation?: number
}): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute(DATA_SPINDLE_MOUNT_ATTR, options.mount)
  el.setAttribute(DATA_SPINDLE_SCOPE_ATTR, options.scope)
  if (options.owner) el.setAttribute(DATA_SPINDLE_OWNER_ATTR, options.owner)
  if (options.generation !== undefined) el.setAttribute(DATA_SPINDLE_GENERATION_ATTR, String(options.generation))
  return el
}

function identityKey(owner: string, generation: number, mount: string, scope: string): string {
  return `${owner}\0${generation}\0${mount}\0${scope}`
}

function rootStorageKey(owner: string, generation: number, mount: string, scope: string, liveAnchorId: string): string {
  return `${identityKey(owner, generation, mount, scope)}\0${liveAnchorId}`
}

function ownerGenerationKey(owner: string, generation: number): string {
  return `${owner}\0${generation}`
}

function sanitizeExtensionMarkup(markup: string): string {
  return sanitizeRichHtml(markup)
}

function stripForgedOwnership(root: ParentNode): void {
  const nodes: Element[] = []
  if (root instanceof Element) nodes.push(root)
  if ('querySelectorAll' in root) nodes.push(...Array.from(root.querySelectorAll('*')))
  for (const node of nodes) {
    for (const attr of FORGED_OWNERSHIP_ATTRS) {
      node.removeAttribute(attr)
    }
  }
}

function wrapKind(kind: DecoratorKind | undefined): HTMLElement {
  if (kind === 'badge') {
    const el = document.createElement('span')
    el.setAttribute('data-spindle-decorator-kind', 'badge')
    return el
  }
  if (kind === 'button') {
    const el = document.createElement('button')
    el.type = 'button'
    el.setAttribute('data-spindle-decorator-kind', 'button')
    return el
  }
  if (kind === 'context-action') {
    const el = document.createElement('button')
    el.type = 'button'
    el.setAttribute('data-spindle-decorator-kind', 'context-action')
    return el
  }
  const el = document.createElement('div')
  el.setAttribute('data-spindle-decorator-kind', kind ?? 'html')
  return el
}

function fillSanitized(target: HTMLElement, html?: string, svg?: string): void {
  const markup = html ?? svg ?? ''
  if (!markup) {
    target.replaceChildren()
    return
  }
  const holder = document.createElement('div')
  holder.innerHTML = sanitizeExtensionMarkup(markup)
  stripForgedOwnership(holder)
  target.replaceChildren(...Array.from(holder.childNodes))
}

class DomDecoratorServiceImpl implements DomDecoratorService {
  private readonly anchorsByLiveAnchorId = new Map<string, AnchorRegistration>()
  private readonly liveAnchorIdByNode = new WeakMap<Element, string>()
  private readonly rootsByStorageKey = new Map<string, RootRecord>()
  private readonly rootsByGenerationMountScope = new Map<string, Set<string>>()
  private readonly registrationsByOwnerGeneration = new Map<string, Set<string>>()
  private readonly decoratorsById = new Map<string, DecoratorRecord>()
  private readonly decoratorsByOwnerGeneration = new Map<string, Set<string>>()
  private readonly pending: PendingWork = { teardowns: [], mounts: [] }
  private frameId: number | null = null
  private observer: MutationObserver | null = null
  private nextLiveAnchor = 1
  private nextDecorator = 1
  private disposed = false

  constructor(private readonly runtime: object) {}

  registerAnchor(input: AnchorRegistrationInput): AnchorRegistration {
    this.assertActive()
    const scope = input.scope.trim()
    if (!scope) throw new Error('SPINDLE_DECORATOR_SCOPE_REQUIRED')
    if (!input.mount) throw new Error('SPINDLE_DECORATOR_MOUNT_REQUIRED')
    if (!input.owner) throw new Error('SPINDLE_DECORATOR_OWNER_REQUIRED')

    const existingId = this.liveAnchorIdByNode.get(input.node)
    if (existingId) {
      const existing = this.anchorsByLiveAnchorId.get(existingId)
      if (existing) {
        const sameIdentity = existing.mount === input.mount
          && existing.scope === scope
          && existing.owner === input.owner
          && existing.generation === input.generation
          && existing.instanceKey === input.instanceKey
        if (sameIdentity) {
          existing.node = input.node
          this.queueMount(() => this.mountAnchor(existing))
          return existing
        }
        this.unregisterAnchor(existing.liveAnchorId)
      }
    }

    const liveAnchorId = `live-anchor:${this.nextLiveAnchor++}`
    const registration: AnchorRegistration = {
      mount: input.mount,
      scope,
      liveAnchorId,
      owner: input.owner,
      generation: input.generation,
      node: input.node,
      instanceKey: input.instanceKey,
    }
    this.anchorsByLiveAnchorId.set(liveAnchorId, registration)
    this.liveAnchorIdByNode.set(input.node, liveAnchorId)
    const ownerKey = ownerGenerationKey(input.owner, input.generation)
    const ownerSet = this.registrationsByOwnerGeneration.get(ownerKey) ?? new Set<string>()
    ownerSet.add(liveAnchorId)
    this.registrationsByOwnerGeneration.set(ownerKey, ownerSet)
    this.queueMount(() => this.mountAnchor(registration))
    return registration
  }

  unregisterAnchor(nodeOrId: Element | string): void {
    if (this.disposed) return
    const liveAnchorId = typeof nodeOrId === 'string' ? nodeOrId : this.liveAnchorIdByNode.get(nodeOrId)
    if (!liveAnchorId) return
    const registration = this.anchorsByLiveAnchorId.get(liveAnchorId)
    if (!registration) return

    this.anchorsByLiveAnchorId.delete(liveAnchorId)
    this.liveAnchorIdByNode.delete(registration.node)
    const ownerKey = ownerGenerationKey(registration.owner, registration.generation)
    const ownerSet = this.registrationsByOwnerGeneration.get(ownerKey)
    ownerSet?.delete(liveAnchorId)
    if (ownerSet && ownerSet.size === 0) this.registrationsByOwnerGeneration.delete(ownerKey)

    const storageKey = rootStorageKey(
      registration.owner,
      registration.generation,
      registration.mount,
      registration.scope,
      liveAnchorId,
    )
    this.queueTeardown(() => this.teardownRoot(storageKey))
  }

  registerDecorator(options: DecoratorOptions): () => void {
    this.assertActive()
    if (!options.mount) throw new Error('SPINDLE_DECORATOR_MOUNT_REQUIRED')
    if (!options.owner) throw new Error('SPINDLE_DECORATOR_OWNER_REQUIRED')

    const decoratorKey = `${options.owner}\0${options.generation}\0${options.mount}\0${options.instanceKey ?? ''}`
    for (const existing of this.decoratorsById.values()) {
      if (existing.disposed) continue
      const same = existing.options.owner === options.owner
        && existing.options.generation === options.generation
        && existing.options.mount === options.mount
        && existing.options.instanceKey === options.instanceKey
      if (same) {
        existing.options = options
        this.queueMount(() => this.replayMatching(options.mount, options.owner, options.generation))
        return () => this.disposeDecorator(existing.id)
      }
    }

    const id = `decorator:${this.nextDecorator++}:${decoratorKey}`
    const record: DecoratorRecord = { id, options, disposed: false }
    this.decoratorsById.set(id, record)
    const ownerKey = ownerGenerationKey(options.owner, options.generation)
    const set = this.decoratorsByOwnerGeneration.get(ownerKey) ?? new Set<string>()
    set.add(id)
    this.decoratorsByOwnerGeneration.set(ownerKey, set)
    this.queueMount(() => this.replayMatching(options.mount, options.owner, options.generation))

    let active = true
    return () => {
      if (!active) return
      active = false
      this.disposeDecorator(id)
    }
  }

  inject(input: {
    owner: string
    generation: number
    mount: string
    scope: string
    html?: string
    svg?: string
    kind?: DecoratorKind
  }): HTMLElement | null {
    this.assertActive()
    const matches = [...this.anchorsByLiveAnchorId.values()].filter((registration) => (
      registration.owner === input.owner
      && registration.generation === input.generation
      && registration.mount === input.mount
      && registration.scope === input.scope
    ))
    if (matches.length === 0) return null

    let last: HTMLElement | null = null
    for (const registration of matches) {
      const rootRecord = this.ensureRoot(registration)
      last = this.writeInjected(rootRecord, `inject:${input.kind ?? 'html'}`, input.kind, input.html, input.svg)
    }
    return last
  }

  replay(node?: Element): void {
    if (this.disposed) return
    if (node) {
      const registration = this.getRegistration(node)
      if (!registration) return
      this.queueMount(() => this.mountAnchor(registration))
      return
    }
    this.queueMount(() => {
      for (const registration of this.anchorsByLiveAnchorId.values()) {
        this.mountAnchor(registration)
      }
    })
  }

  detachPortal(node: Element): void {
    this.unregisterAnchor(node)
  }

  unloadGeneration(owner: string, generation: number): void {
    if (this.disposed) return
    const ownerKey = ownerGenerationKey(owner, generation)
    const liveIds = [...(this.registrationsByOwnerGeneration.get(ownerKey) ?? [])]
    for (const liveAnchorId of liveIds) {
      this.unregisterAnchor(liveAnchorId)
    }
    const decoratorIds = [...(this.decoratorsByOwnerGeneration.get(ownerKey) ?? [])]
    for (const id of decoratorIds) {
      this.disposeDecorator(id)
    }
    this.maybeReleaseObserver()
  }

  ensureLegacyObserver(): void {
    this.assertActive()
    if (this.observer) {
      this.scanLegacyHosts()
      return
    }
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return
    const root = document.body ?? document.documentElement
    if (!root) return
    this.observer = new MutationObserver(() => {
      this.scanLegacyHosts()
    })
    this.observer.observe(root, { childList: true, subtree: true, attributes: true })
    this.scanLegacyHosts()
  }

  scanLegacyHosts(): void {
    if (this.disposed || typeof document === 'undefined') return
    const hosts = document.querySelectorAll(`[${DATA_SPINDLE_MOUNT_ATTR}][${DATA_SPINDLE_SCOPE_ATTR}]`)
    for (const host of hosts) {
      if (this.liveAnchorIdByNode.has(host)) continue
      const mount = host.getAttribute(DATA_SPINDLE_MOUNT_ATTR)
      const scope = host.getAttribute(DATA_SPINDLE_SCOPE_ATTR)
      const owner = host.getAttribute(DATA_SPINDLE_OWNER_ATTR)
      const generationRaw = host.getAttribute(DATA_SPINDLE_GENERATION_ATTR)
      if (!mount || !scope || !owner || generationRaw == null) continue
      const generation = Number(generationRaw)
      if (!Number.isFinite(generation)) continue
      this.registerAnchor({ mount, scope, owner, generation, node: host })
    }
  }

  flush(): void {
    if (this.frameId != null) {
      cancelScheduledFrame(this.frameId)
      this.frameId = null
    }
    this.flushPending()
  }

  getRoot(owner: string, generation: number, mount: string, scope: string, liveAnchorId?: string): HTMLElement | null {
    if (liveAnchorId) {
      return this.rootsByStorageKey.get(rootStorageKey(owner, generation, mount, scope, liveAnchorId))?.root ?? null
    }
    const identity = identityKey(owner, generation, mount, scope)
    const storageKeys = this.rootsByGenerationMountScope.get(identity)
    if (!storageKeys) return null
    for (const storageKey of storageKeys) {
      const record = this.rootsByStorageKey.get(storageKey)
      if (record) return record.root
    }
    return null
  }

  getRegistration(node: Element): AnchorRegistration | null {
    const liveAnchorId = this.liveAnchorIdByNode.get(node)
    if (!liveAnchorId) return null
    return this.anchorsByLiveAnchorId.get(liveAnchorId) ?? null
  }

  getCounters(owner: string, generation: number): SpindleExtensionCounters {
    const ownerKey = ownerGenerationKey(owner, generation)
    let roots = 0
    let callbacks = 0
    let injectedNodes = 0
    for (const record of this.rootsByStorageKey.values()) {
      if (record.owner !== owner || record.generation !== generation) continue
      roots += 1
      callbacks += record.disposers.size
      injectedNodes += record.injected.size
    }
    return {
      extensionOwnedRawMutationObservers: 0,
      documentWideCoreSelectorScrapes: 0,
      decoratorObservers: this.observer ? 1 : 0,
      roots,
      callbacks,
      injectedNodes,
      registrations: this.registrationsByOwnerGeneration.get(ownerKey)?.size ?? 0,
    }
  }

  dispose(): void {
    if (this.disposed) return
    const generations = [...this.registrationsByOwnerGeneration.keys(), ...this.decoratorsByOwnerGeneration.keys()]
    for (const key of new Set(generations)) {
      const [owner, generationRaw] = key.split('\0')
      this.unloadGeneration(owner, Number(generationRaw))
    }
    this.flush()
    this.releaseObserver()
    this.disposed = true
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('SPINDLE_DECORATOR_DISPOSED')
  }

  private queueMount(work: () => void): void {
    this.pending.mounts.push(work)
    this.scheduleFrame()
  }

  private queueTeardown(work: () => void): void {
    this.pending.teardowns.push(work)
    this.scheduleFrame()
  }

  private scheduleFrame(): void {
    if (this.frameId != null) return
    this.frameId = scheduleFrame(() => {
      this.frameId = null
      this.flushPending()
    })
  }

  private flushPending(): void {
    const teardowns = this.pending.teardowns.splice(0)
    const mounts = this.pending.mounts.splice(0)
    for (const work of teardowns) work()
    for (const work of mounts) work()
  }

  private hasDecorator(registration: AnchorRegistration): boolean {
    for (const decorator of this.decoratorsById.values()) {
      if (decorator.disposed) continue
      if (decorator.options.owner !== registration.owner) continue
      if (decorator.options.generation !== registration.generation) continue
      if (decorator.options.mount !== registration.mount) continue
      if (decorator.options.instanceKey !== undefined && decorator.options.instanceKey !== registration.instanceKey) continue
      return true
    }
    return false
  }

  private mountAnchor(registration: AnchorRegistration): void {
    if (!this.anchorsByLiveAnchorId.has(registration.liveAnchorId)) return
    if (!this.hasDecorator(registration)) return
    const rootRecord = this.ensureRoot(registration)
    if (rootRecord.root.parentElement !== registration.node) {
      registration.node.appendChild(rootRecord.root)
    }
    this.applyDecorators(registration, rootRecord)
  }

  private ensureRoot(registration: AnchorRegistration): RootRecord {
    const storageKey = rootStorageKey(
      registration.owner,
      registration.generation,
      registration.mount,
      registration.scope,
      registration.liveAnchorId,
    )
    const existing = this.rootsByStorageKey.get(storageKey)
    if (existing) return existing

    const identity = identityKey(registration.owner, registration.generation, registration.mount, registration.scope)
    const root = document.createElement('div')
    stampExtensionRoot(root, registration.owner, 'data-spindle-extension-root')
    root.setAttribute('data-spindle-mount-literal', registration.mount)
    root.setAttribute(DATA_SPINDLE_SCOPE_ATTR, registration.scope)
    const record: RootRecord = {
      root,
      identityKey: identity,
      liveAnchorId: registration.liveAnchorId,
      owner: registration.owner,
      generation: registration.generation,
      mount: registration.mount,
      scope: registration.scope,
      injected: new Map(),
      disposers: new Map(),
    }
    this.rootsByStorageKey.set(storageKey, record)
    const identitySet = this.rootsByGenerationMountScope.get(identity) ?? new Set<string>()
    identitySet.add(storageKey)
    this.rootsByGenerationMountScope.set(identity, identitySet)
    return record
  }

  private applyDecorators(registration: AnchorRegistration, rootRecord: RootRecord): void {
    const matching = [...this.decoratorsById.values()]
      .filter((decorator) => (
        !decorator.disposed
        && decorator.options.owner === registration.owner
        && decorator.options.generation === registration.generation
        && decorator.options.mount === registration.mount
        && (decorator.options.instanceKey === undefined || decorator.options.instanceKey === registration.instanceKey)
      ))
      .sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))

    for (const decorator of matching) {
      this.applyDecorator(registration, rootRecord, decorator)
    }
  }

  private applyDecorator(registration: AnchorRegistration, rootRecord: RootRecord, decorator: DecoratorRecord): void {
    const ctx: DecoratorRenderContext = {
      mount: registration.mount,
      scope: registration.scope,
      liveAnchorId: registration.liveAnchorId,
      owner: registration.owner,
      generation: registration.generation,
      node: registration.node,
      root: rootRecord.root,
    }

    if (rootRecord.disposers.has(decorator.id) || rootRecord.injected.has(decorator.id)) {
      decorator.options.update?.(rootRecord.root, ctx)
      return
    }

    if (decorator.options.html || decorator.options.svg || decorator.options.kind) {
      this.writeInjected(rootRecord, decorator.id, decorator.options.kind, decorator.options.html, decorator.options.svg)
    }

    const disposer = decorator.options.render?.(rootRecord.root, ctx)
    if (typeof disposer === 'function') {
      rootRecord.disposers.set(decorator.id, disposer)
    }
  }

  private writeInjected(
    rootRecord: RootRecord,
    injectedId: string,
    kind?: DecoratorKind,
    html?: string,
    svg?: string,
  ): HTMLElement {
    let slot = rootRecord.injected.get(injectedId)
    if (!slot) {
      slot = wrapKind(kind)
      slot.setAttribute('data-spindle-injected', injectedId)
      rootRecord.root.appendChild(slot)
      rootRecord.injected.set(injectedId, slot)
    }
    fillSanitized(slot, html, svg)
    return slot
  }

  private replayMatching(mount: string, owner: string, generation: number): void {
    for (const registration of this.anchorsByLiveAnchorId.values()) {
      if (registration.mount !== mount) continue
      if (registration.owner !== owner || registration.generation !== generation) continue
      this.mountAnchor(registration)
    }
  }

  private disposeDecorator(id: string): void {
    const decorator = this.decoratorsById.get(id)
    if (!decorator || decorator.disposed) return
    decorator.disposed = true
    this.decoratorsById.delete(id)
    const ownerKey = ownerGenerationKey(decorator.options.owner, decorator.options.generation)
    const set = this.decoratorsByOwnerGeneration.get(ownerKey)
    set?.delete(id)
    if (set && set.size === 0) this.decoratorsByOwnerGeneration.delete(ownerKey)

    this.queueTeardown(() => {
      for (const record of this.rootsByStorageKey.values()) {
        if (record.owner !== decorator.options.owner || record.generation !== decorator.options.generation) continue
        const disposer = record.disposers.get(id)
        if (disposer) {
          try { disposer() } catch { /* no-op */ }
          record.disposers.delete(id)
        }
        const injected = record.injected.get(id)
        if (injected) {
          injected.remove()
          record.injected.delete(id)
        }
      }
    })
  }

  private teardownRoot(storageKey: string): void {
    const record = this.rootsByStorageKey.get(storageKey)
    if (!record) return
    for (const disposer of record.disposers.values()) {
      try { disposer() } catch { /* no-op */ }
    }
    record.disposers.clear()
    for (const injected of record.injected.values()) {
      injected.remove()
    }
    record.injected.clear()
    for (const attr of FORGED_OWNERSHIP_ATTRS) {
      record.root.removeAttribute(attr)
    }
    record.root.replaceChildren()
    record.root.remove()
    this.rootsByStorageKey.delete(storageKey)
    const identitySet = this.rootsByGenerationMountScope.get(record.identityKey)
    identitySet?.delete(storageKey)
    if (identitySet && identitySet.size === 0) this.rootsByGenerationMountScope.delete(record.identityKey)
    this.maybeReleaseObserver()
  }

  private maybeReleaseObserver(): void {
    if (this.anchorsByLiveAnchorId.size > 0) return
    if (this.decoratorsById.size > 0) return
    this.releaseObserver()
  }

  private releaseObserver(): void {
    if (!this.observer) return
    this.observer.disconnect()
    this.observer = null
  }
}

const DEFAULT_RUNTIME: object = {}
const services = new Map<object, DomDecoratorServiceImpl>()

function scheduleFrame(work: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(work)
  return setTimeout(work, 0) as unknown as number
}

function cancelScheduledFrame(id: number): void {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(id)
    return
  }
  clearTimeout(id)
}

function rebindDiagnostics(): void {
  bindSpindleExtensionDiagnosticsGetter((owner, generation) => {
    const totals: SpindleExtensionCounters = {
      extensionOwnedRawMutationObservers: 0,
      documentWideCoreSelectorScrapes: 0,
      decoratorObservers: 0,
      roots: 0,
      callbacks: 0,
      injectedNodes: 0,
      registrations: 0,
    }
    for (const service of services.values()) {
      const part = service.getCounters(owner, generation)
      totals.extensionOwnedRawMutationObservers += part.extensionOwnedRawMutationObservers
      totals.documentWideCoreSelectorScrapes += part.documentWideCoreSelectorScrapes
      totals.decoratorObservers = Math.max(totals.decoratorObservers, part.decoratorObservers)
      totals.roots += part.roots
      totals.callbacks += part.callbacks
      totals.injectedNodes += part.injectedNodes
      totals.registrations += part.registrations
    }
    return totals
  })
}

export function getDomDecoratorService(runtime: object = DEFAULT_RUNTIME): DomDecoratorService {
  let service = services.get(runtime)
  if (!service) {
    service = new DomDecoratorServiceImpl(runtime)
    services.set(runtime, service)
    rebindDiagnostics()
  }
  return service
}

export function flushDomDecoratorWork(): void {
  for (const service of services.values()) service.flush()
}

export function resetDomDecoratorServicesForTests(): void {
  for (const service of services.values()) service.dispose()
  services.clear()
  rebindDiagnostics()
}
