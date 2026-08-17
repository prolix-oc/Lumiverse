import type { ComponentType } from 'react'
import {
  BrainCircuit,
  FolderOpen,
  ListChecks,
  Plus,
  Settings2,
  Sliders,
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

export interface BuildChatDockerActionCatalogOptions {
  owners?: ChatDockerActionOwners
  scope?: ChatDockerActionScope
}

let registeredOwners: ChatDockerActionOwners = {}
const ownerListeners = new Set<() => void>()

export function registerChatDockerActionOwners(next: ChatDockerActionOwners | null): () => void {
  registeredOwners = next ? { ...registeredOwners, ...next } : {}
  ownerListeners.forEach((listener) => listener())
  return () => {
    if (!next) return
    registeredOwners = Object.fromEntries(
      Object.entries(registeredOwners).filter(([, value]) => !Object.values(next).includes(value)),
    ) as ChatDockerActionOwners
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
  const promptDisabled = !presetAvailable || Boolean(scope.promptVariablesLoading)
  const convertHidden = Boolean(scope.isGroupChat)
  const convertDisabled = !hasChat || !hasCharacter || convertHidden
  const groupCreatorDisabled = scope.groupChatCreatorRegistered === false
  const memoriesDisabled = !hasChat
    || scope.memoryCortexAvailable === false
    || Boolean(scope.memoryCortexInFlight)

  const catalog: ChatDockerAction[] = [
    {
      id: 'chat.new',
      label: 'New Chat',
      description: 'Start a new chat with the current character.',
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
      label: 'Manage Chats',
      description: 'Open the chat manager for the current character.',
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
      label: 'Prompt Variables',
      description: 'Edit prompt variables for the active preset.',
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
      label: 'Chat Settings',
      description: 'Open settings for the current chat.',
      keywords: ['chat', 'settings'],
      icon: Settings2,
      disabled: !hasChat,
      hidden: false,
      run: () => {
        if (!hasChat) return
        if (owners.openChatSettings) {
          owners.openChatSettings()
          return
        }
        owners.openModal?.('chatSettings', { chatId: scope.activeChatId })
      },
    },
    {
      id: 'chat.convert-to-group',
      label: 'Convert to Group',
      description: 'Convert the current chat into a group chat.',
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
      label: 'New Group',
      description: 'Open the group chat creator.',
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
      label: "Author's Note",
      description: 'Open the author note for the current chat.',
      keywords: ['authors', 'note'],
      icon: StickyNote,
      disabled: !hasChat,
      hidden: false,
      run: () => {
        if (!hasChat) return
        owners.setAuthorsNoteOpen?.(true)
      },
    },
    {
      id: 'chat.recompile-memories',
      label: 'Recompile Memories',
      description: 'Force a Memory Cortex warm for the current chat.',
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
      label: 'Select messages',
      description: 'Toggle message selection mode in the current chat.',
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
  ]

  return [...new Map(catalog.map((action) => [action.id, action])).values()]
}

export function collectChatDockerActionIds(actions: ReadonlyArray<{ id: string }>): string[] {
  return CHAT_DOCKER_ACTION_IDS.filter((id) => actions.some((action) => action.id === id))
}

export function countActionId(actions: ReadonlyArray<{ id: string }>, id: string): number {
  return actions.reduce((total, action) => total + (action.id === id ? 1 : 0), 0)
}
