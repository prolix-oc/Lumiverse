import type { ComponentType } from 'react'
import {
  ArrowUp,
  BrainCircuit,
  FolderOpen,
  List,
  ListChecks,
  Plus,
  Settings2,
  Sliders,
  SlidersHorizontal,
  StickyNote,
  UserPlus,
  UsersRound,
} from 'lucide-react'
import { memoryCortexApi } from '@/api/memory-cortex'
import { COMMANDS } from '@/lib/commands'
import { useStore } from '@/store'

export const CHAT_DOCKER_ACTION_IDS = [
  'chat.new',
  'chat.manage',
  'chat.prompt-variables',
  'chat.settings',
  'chat.convert-to-group',
  'chat.new-group',
  'chat.authors-note',
  'chat.recompile-memories',
  'chat.select-messages',
  'chat.scroll-to-top',
  'chat.browse-messages',
  'chat.customize-composer',
] as const

export type ChatDockerActionId = (typeof CHAT_DOCKER_ACTION_IDS)[number]

export type ChatDockerActionIcon = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>

export interface ChatDockerActionScope {
  activeCharacterId?: string | null
  activeChatId?: string | null
  isGroupChat?: boolean
  activeLoomPresetId?: string | null
  promptVariablesLoading?: boolean
  memoryCortexAvailable?: boolean
  memoryCortexInFlight?: boolean
  groupChatCreatorRegistered?: boolean
}

export interface ChatDockerCommandOwner {
  id: string
  scope?: string
  run: (navigate?: (path: string) => void) => void | Promise<void>
}

export interface ChatDockerActionOwners {
  createNewChat?: (deleteThisChat?: boolean) => void | Promise<void>
  openPromptVariablesModal?: () => void | Promise<void>
  handleConvertToGroup?: () => void | Promise<void>
  setAuthorsNoteOpen?: (open: boolean) => void
  openChatSettings?: () => void
  openGroupChatCreator?: () => void
  openModal?: (id: string, payload?: unknown) => void
  warmMemories?: (chatId: string) => void | Promise<void>
  navigateToOldestMessage?: () => void | Promise<void>
  navigateToOldestMessageLoading?: boolean
  openMessageNavigator?: () => void
  openComposerCustomize?: () => void
  runCommand?: (id: string) => void | Promise<void>
  findCommand?: (id: string) => ChatDockerCommandOwner | undefined
  navigate?: (path: string) => void
  promptVariablesLoading?: boolean
  memoryCortexAvailable?: boolean
  memoryCortexInFlight?: boolean
  groupChatCreatorRegistered?: boolean
}

export interface ChatDockerAction {
  id: ChatDockerActionId
  label: string
  description: string
  keywords: string[]
  icon: ChatDockerActionIcon
  disabled: boolean
  hidden: boolean
  presetAvailable?: boolean
  run: () => void
}

export type ChatDockerActionTranslate = (key: string, options?: Record<string, unknown>) => string

export interface BuildChatDockerActionCatalogOptions {
  owners?: ChatDockerActionOwners
  scope?: ChatDockerActionScope
  translate?: ChatDockerActionTranslate
}

let registeredOwners: ChatDockerActionOwners = {}
const ownerListeners = new Set<() => void>()
const ownerRegistrationByKey = new Map<keyof ChatDockerActionOwners, symbol>()

export function registerChatDockerActionOwners(next: ChatDockerActionOwners | null): () => void {
  if (!next) {
    registeredOwners = {}
    ownerRegistrationByKey.clear()
    ownerListeners.forEach((listener) => listener())
    return () => undefined
  }

  const registration = Symbol('chat-docker-owner-registration')
  const registrationOwners = { ...next }
  const registrationKeys = Object.keys(registrationOwners) as Array<keyof ChatDockerActionOwners>
  registeredOwners = { ...registeredOwners, ...registrationOwners }
  registrationKeys.forEach((key) => ownerRegistrationByKey.set(key, registration))
  ownerListeners.forEach((listener) => listener())

  let cleanedUp = false
  return () => {
    if (cleanedUp) return
    cleanedUp = true

    let cleanedAny = false
    let ownersAfterCleanup = registeredOwners
    for (const key of registrationKeys) {
      if (ownerRegistrationByKey.get(key) !== registration) continue
      ownerRegistrationByKey.delete(key)
      if (
        !Object.prototype.hasOwnProperty.call(registeredOwners, key)
        || !Object.is(registeredOwners[key], registrationOwners[key])
      ) {
        continue
      }
      if (!cleanedAny) ownersAfterCleanup = { ...registeredOwners }
      delete ownersAfterCleanup[key]
      cleanedAny = true
    }

    if (!cleanedAny) return
    registeredOwners = ownersAfterCleanup
    ownerListeners.forEach((listener) => listener())
  }
}

export function getChatDockerActionOwners(): ChatDockerActionOwners {
  return registeredOwners
}

export function subscribeChatDockerActionOwners(listener: () => void): () => void {
  ownerListeners.add(listener)
  return () => ownerListeners.delete(listener)
}

function defaultFindCommand(id: string): ChatDockerCommandOwner | undefined {
  const command = COMMANDS.find((entry) => entry.id === id)
  if (!command) return undefined
  return { id: command.id, scope: command.scope, run: command.run }
}

function invokeCommand(owners: ChatDockerActionOwners, id: string): void {
  if (owners.runCommand) {
    void owners.runCommand(id)
    return
  }
  const command = (owners.findCommand ?? defaultFindCommand)(id)
  void command?.run(owners.navigate)
}

export function buildChatDockerActionCatalog(
  options: BuildChatDockerActionCatalogOptions = {},
): ChatDockerAction[] {
  const owners = { ...registeredOwners, ...options.owners }
  const text: ChatDockerActionTranslate = options.translate ?? ((key) => key)
  const scope: ChatDockerActionScope = {
    promptVariablesLoading: owners.promptVariablesLoading,
    memoryCortexAvailable: owners.memoryCortexAvailable,
    memoryCortexInFlight: owners.memoryCortexInFlight,
    groupChatCreatorRegistered: owners.groupChatCreatorRegistered,
    ...options.scope,
  }

  const hasChat = Boolean(scope.activeChatId)
  const hasCharacter = Boolean(scope.activeCharacterId)
  const presetAvailable = Boolean(scope.activeLoomPresetId)
  const promptDisabled = !presetAvailable || Boolean(scope.promptVariablesLoading) || !owners.openPromptVariablesModal
  const convertHidden = Boolean(scope.isGroupChat)
  const convertDisabled = !hasChat || !hasCharacter || convertHidden || !owners.handleConvertToGroup
  const groupCreatorDisabled = scope.groupChatCreatorRegistered === false
    || (!owners.openGroupChatCreator && !owners.openModal)
  const authorsNoteDisabled = !hasChat || !owners.setAuthorsNoteOpen
  const memoriesDisabled = !hasChat
    || scope.memoryCortexAvailable === false
    || Boolean(scope.memoryCortexInFlight)
  const scrollToTopDisabled = !hasChat || !owners.navigateToOldestMessage || Boolean(owners.navigateToOldestMessageLoading)
  const browseMessagesDisabled = !hasChat || !owners.openMessageNavigator
  const catalog: ChatDockerAction[] = [
    {
      id: 'chat.new',
      label: text('chatDocker.new.label'),
      description: text('chatDocker.new.description'),
      keywords: ['new', 'chat', 'plus'],
      icon: Plus,
      disabled: false,
      hidden: false,
      run: () => {
        if (owners.createNewChat) {
          void owners.createNewChat()
          return
        }
        invokeCommand(owners, 'action-new-chat')
      },
    },
    {
      id: 'chat.manage',
      label: text('chatDocker.manage.label'),
      description: text('chatDocker.manage.description'),
      keywords: ['manage', 'chats', 'history'],
      icon: FolderOpen,
      disabled: !hasCharacter,
      hidden: false,
      run: () => {
        if (!hasCharacter) return
        invokeCommand(owners, 'action-manage-chats')
      },
    },
    {
      id: 'chat.prompt-variables',
      label: text('chatDocker.promptVariables.label'),
      description: text('chatDocker.promptVariables.description'),
      keywords: ['prompt', 'variables', 'preset'],
      icon: Sliders,
      disabled: promptDisabled,
      hidden: false,
      presetAvailable,
      run: () => {
        if (promptDisabled) return
        void owners.openPromptVariablesModal?.()
      },
    },
    {
      id: 'chat.settings',
      label: text('chatDocker.settings.label'),
      description: text('chatDocker.settings.description'),
      keywords: ['chat', 'settings'],
      icon: Settings2,
      disabled: !hasChat || (!owners.openChatSettings && !owners.openModal),
      hidden: false,
      run: () => {
        if (!hasChat || (!owners.openChatSettings && !owners.openModal)) return
        if (owners.openChatSettings) {
          owners.openChatSettings()
          return
        }
        owners.openModal?.('chatSettings', { chatId: scope.activeChatId })
      },
    },
    {
      id: 'chat.convert-to-group',
      label: text('chatDocker.convertToGroup.label'),
      description: text('chatDocker.convertToGroup.description'),
      keywords: ['convert', 'group'],
      icon: UserPlus,
      disabled: convertDisabled,
      hidden: convertHidden,
      run: () => {
        if (convertDisabled) return
        void owners.handleConvertToGroup?.()
      },
    },
    {
      id: 'chat.new-group',
      label: text('chatDocker.newGroup.label'),
      description: text('chatDocker.newGroup.description'),
      keywords: ['new', 'group'],
      icon: UsersRound,
      disabled: groupCreatorDisabled,
      hidden: false,
      run: () => {
        if (groupCreatorDisabled) return
        if (owners.openGroupChatCreator) {
          owners.openGroupChatCreator()
          return
        }
        owners.openModal?.('groupChatCreator')
      },
    },
    {
      id: 'chat.authors-note',
      label: text('chatDocker.authorsNote.label'),
      description: text('chatDocker.authorsNote.description'),
      keywords: ['authors', 'note'],
      icon: StickyNote,
      disabled: authorsNoteDisabled,
      hidden: false,
      run: () => {
        if (authorsNoteDisabled) return
        owners.setAuthorsNoteOpen?.(true)
      },
    },
    {
      id: 'chat.recompile-memories',
      label: text('chatDocker.recompileMemories.label'),
      description: text('chatDocker.recompileMemories.description'),
      keywords: ['memory', 'cortex', 'recompile', 'warm'],
      icon: BrainCircuit,
      disabled: memoriesDisabled,
      hidden: false,
      run: () => {
        if (memoriesDisabled || !scope.activeChatId) return
        const warm = owners.warmMemories ?? ((chatId: string) => memoryCortexApi.warm(chatId, { force: true }))
        void warm(scope.activeChatId)
      },
    },
    {
      id: 'chat.select-messages',
      label: text('chatDocker.selectMessages.label'),
      description: text('chatDocker.selectMessages.description'),
      keywords: ['select', 'messages', 'bulk', 'list-checks'],
      icon: ListChecks,
      disabled: !hasChat,
      hidden: false,
      run: () => {
        if (!hasChat) return
        const state = useStore.getState()
        state.setMessageSelectMode(!state.messageSelectMode)
      },
    },
    {
      id: 'chat.scroll-to-top',
      label: text('chatDocker.scrollToTop.label'),
      description: text('chatDocker.scrollToTop.description'),
      keywords: ['scroll', 'top', 'oldest', 'first', 'message', 'arrow-up'],
      icon: ArrowUp,
      disabled: scrollToTopDisabled,
      hidden: false,
      run: () => {
        if (scrollToTopDisabled) return
        void owners.navigateToOldestMessage?.()
      },
    },
    {
      id: 'chat.browse-messages',
      label: text('chatDocker.browseMessages.label'),
      description: text('chatDocker.browseMessages.description'),
      keywords: ['browse', 'messages', 'navigator', 'list', 'jump'],
      icon: List,
      disabled: browseMessagesDisabled,
      hidden: false,
      run: () => {
        if (browseMessagesDisabled) return
        owners.openMessageNavigator?.()
      },
    },
    {
      id: 'chat.customize-composer',
      label: text('chatDocker.customizeComposer.label'),
      description: text('chatDocker.customizeComposer.description'),
      keywords: ['customize', 'composer', 'action-bar', 'gear', 'sliders'],
      icon: SlidersHorizontal,
      disabled: !owners.openComposerCustomize,
      hidden: false,
      run: () => {
        owners.openComposerCustomize?.()
      },
    },
  ]

  return [...new Map<string, ChatDockerAction>(
    catalog.map((action): [string, ChatDockerAction] => [action.id, action]),
  ).values()]
}

export function collectChatDockerActionIds(actions: ReadonlyArray<{ id: string }>): string[] {
  return CHAT_DOCKER_ACTION_IDS.filter((id) => actions.some((action) => action.id === id))
}

export function countActionId(actions: ReadonlyArray<{ id: string }>, id: string): number {
  return actions.reduce((total, action) => total + (action.id === id ? 1 : 0), 0)
}
