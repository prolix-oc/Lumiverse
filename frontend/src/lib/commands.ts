import type { NavigateFunction } from 'react-router'
import type { ComponentType } from 'react'
import {
  Plus, RotateCw, CornerDownLeft, Trash2, Edit3, Copy,
  Eye, EyeOff, Columns, FolderOpen, ClipboardCopy, Upload, Search,
  GitBranch,
} from 'lucide-react'
import i18n from '@/i18n'
import { useStore } from '@/store'
import { chatsApi, messagesApi } from '@/api/chats'
import { generateApi } from '@/api/generate'
import { charactersApi } from '@/api/characters'
import { DRAWER_TABS, registryToCommands } from '@/lib/drawer-tab-registry'
import { getVisibleSettingsTabs, settingsRegistryToCommands } from '@/lib/settings-tab-registry'
import { copyTextToClipboard } from '@/lib/clipboard'
import { shouldForceLoomRuntimePreset } from '@/lib/loom/runtimeProfile'

export type CommandScope = 'global' | 'chat' | 'chat-idle' | 'landing' | 'character'

export type CommandGroup = 'actions' | 'panels' | 'settings' | 'extensions'

export interface Command {
  id: string
  label: string
  description: string
  icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>
  keywords: string[]
  group: CommandGroup
  scope?: CommandScope
  run: (navigate: NavigateFunction) => void | Promise<void>
}

export const GROUP_ORDER: CommandGroup[] = ['actions', 'panels', 'settings', 'extensions']

const tc = (key: string, options?: Record<string, unknown>) => i18n.t(key, { ns: 'commands', ...options })

export const COMMANDS: Command[] = [


  {
    id: 'action-regenerate',
    label: 'Regenerate Response',
    description: 'Delete the last AI reply and generate a new one',
    icon: RotateCw,
    keywords: ['regenerate', 'retry', 'redo', 'reroll', 'response'],
    group: 'actions',
    scope: 'chat-idle',
    run: async () => {
      const { activeChatId, activeProfileId, activePersonaId, activeCharacterId, getActivePresetForGeneration, beginStreaming, startStreaming, setStreamingError, addToast } = useStore.getState()
      if (!activeChatId) return
      beginStreaming()
      try {
        const presetId = getActivePresetForGeneration() || undefined
        const res = await generateApi.regenerate({
          chat_id: activeChatId,
          connection_id: activeProfileId || undefined,
          persona_id: activePersonaId || undefined,
          preset_id: presetId,
          force_preset_id: shouldForceLoomRuntimePreset(presetId, activeChatId, activeCharacterId, activeProfileId),
          generation_type: 'regenerate',
        })
        startStreaming(res.generationId)
      } catch (err: any) {
        const msg = err?.body?.error || err?.message || tc('toast.failedRegenerate')
        setStreamingError(msg)
        addToast({ type: 'error', message: msg })
      }
    },
  },
  {
    id: 'action-continue',
    label: 'Continue Generation',
    description: 'Prompt the AI to continue its last response',
    icon: CornerDownLeft,
    keywords: ['continue', 'extend', 'more', 'nudge', 'generation'],
    group: 'actions',
    scope: 'chat-idle',
    run: async () => {
      const { activeChatId, activeProfileId, activePersonaId, activeCharacterId, getActivePresetForGeneration, beginStreaming, startStreaming, setStreamingError, addToast } = useStore.getState()
      if (!activeChatId) return
      beginStreaming()
      try {
        const presetId = getActivePresetForGeneration() || undefined
        const res = await generateApi.continueGeneration({
          chat_id: activeChatId,
          connection_id: activeProfileId || undefined,
          persona_id: activePersonaId || undefined,
          preset_id: presetId,
          force_preset_id: shouldForceLoomRuntimePreset(presetId, activeChatId, activeCharacterId, activeProfileId),
        })

        startStreaming(res.generationId)
      } catch (err: any) {
        const msg = err?.body?.error || err?.message || tc('toast.failedContinue')
        setStreamingError(msg)
        addToast({ type: 'error', message: msg })
      }
    },
  },

  {
    id: 'action-new-chat',
    label: 'New Chat',
    description: 'Go to the home screen to start a new conversation',
    icon: Plus,
    keywords: ['new', 'chat', 'start', 'home', 'begin', 'create'],
    group: 'actions',
    scope: 'global',
    run: (navigate) => navigate('/'),
  },
  {
    id: 'action-character-browser',
    label: 'Browse Characters',
    description: 'Open the full character library',
    icon: Search,
    keywords: ['characters', 'library', 'browse', 'list', 'cards'],
    group: 'actions',
    scope: 'global',
    run: (navigate) => navigate('/characters'),
  },
  {
    id: 'action-import-character',
    label: 'Import Character',
    description: 'Upload a character card (.png, .charx, .jpg, .json)',
    icon: Upload,
    keywords: ['import', 'upload', 'card', 'character', 'file'],
    group: 'actions',
    scope: 'global',
    run: async () => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.png,.charx,.jpg,.jpeg,.webp,.json'
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0]
        if (!file) return
        const { addToast } = useStore.getState()
        try {
          const res = await charactersApi.importFile(file)
          addToast({ type: 'success', message: tc('toast.importedCharacter', { name: res.character.name }) })
        } catch (err: any) {
          addToast({ type: 'error', message: err?.body?.error || tc('toast.failedImportCharacter') })
        }
      }
      input.click()
    },
  },

  {
    id: 'action-new-chat-same-character',
    label: 'New Chat (Same Character)',
    description: 'Start a fresh conversation with the current character',
    icon: Plus,
    keywords: ['new', 'chat', 'same', 'character', 'fresh', 'restart'],
    group: 'actions',
    scope: 'chat',
    run: (navigate) => {
      const { activeCharacterId } = useStore.getState()
      if (!activeCharacterId) return
      navigate(`/`)
      setTimeout(() => {
        useStore.getState().setActiveCharacter(activeCharacterId)
      }, 50)
    },
  },
  {
    id: 'action-fork-chat',
    label: 'Fork Chat',
    description: 'Branch the current chat at the latest message',
    icon: GitBranch,
    keywords: ['fork', 'branch', 'split', 'alternate', 'copy', 'diverge'],
    group: 'actions',
    scope: 'chat-idle',
    run: async (navigate) => {
      const store = useStore.getState()
      const { activeChatId, messages } = store
      if (!activeChatId || messages.length === 0) return
      const lastMessage = messages[messages.length - 1]
      store.openModal('confirm', {
        title: tc('confirm.forkChat.title'),
        message: tc('confirm.forkChat.message'),
        confirmText: tc('confirm.forkChat.confirm'),
        onConfirm: async () => {
          try {
            const newChat = await chatsApi.branch(activeChatId, lastMessage.id)
            navigate(`/chat/${newChat.id}`)
          } catch {
            useStore.getState().addToast({ type: 'error', message: tc('toast.failedForkChat') })
          }
        },
      })
    },
  },
  {
    id: 'action-manage-chats',
    label: 'Manage Chats',
    description: 'Open the chat manager for the current character',
    icon: FolderOpen,
    keywords: ['manage', 'chats', 'history', 'list', 'browse'],
    group: 'actions',
    scope: 'chat',
    run: () => {
      const { activeCharacterId, characters, isGroupChat, groupCharacterIds, openModal } = useStore.getState()
      if (!activeCharacterId) return
      const char = characters.find((c) => c.id === activeCharacterId)
      openModal('manageChats', {
        characterId: activeCharacterId,
        characterName: isGroupChat ? tc('misc.groupChat') : (char?.name || tc('misc.character')),
        isGroupChat,
        groupCharacterIds,
      })
    },
  },

  {
    id: 'action-copy-last-message',
    label: 'Copy Last Message',
    description: 'Copy the most recent message to clipboard',
    icon: ClipboardCopy,
    keywords: ['copy', 'clipboard', 'last', 'message', 'response'],
    group: 'actions',
    scope: 'chat',
    run: async () => {
      const { messages, addToast } = useStore.getState()
      if (messages.length === 0) return
      const last = messages[messages.length - 1]
      try {
        await copyTextToClipboard(last.content)
        addToast({ type: 'success', message: tc('toast.copiedToClipboard') })
      } catch {
        addToast({ type: 'error', message: tc('toast.failedCopy') })
      }
    },
  },
  {
    id: 'action-delete-last-message',
    label: 'Delete Last Message',
    description: 'Remove the most recent message from this chat',
    icon: Trash2,
    keywords: ['delete', 'remove', 'last', 'message', 'undo'],
    group: 'actions',
    scope: 'chat-idle',
    run: async () => {
      const { activeChatId, messages, removeMessage, addToast } = useStore.getState()
      if (!activeChatId || messages.length === 0) return
      const last = messages[messages.length - 1]
      try {
        await messagesApi.delete(activeChatId, last.id)
        removeMessage(last.id)
        addToast({ type: 'success', message: tc('toast.messageDeleted') })
      } catch {
        addToast({ type: 'error', message: tc('toast.failedDeleteMessage') })
      }
    },
  },
  {
    id: 'action-toggle-hidden-last',
    label: 'Toggle Hide Last Message',
    description: 'Show or hide the last message from AI context',
    icon: EyeOff,
    keywords: ['hide', 'hidden', 'toggle', 'context', 'message', 'exclude'],
    group: 'actions',
    scope: 'chat-idle',
    run: async () => {
      const { activeChatId, messages, addToast } = useStore.getState()
      if (!activeChatId || messages.length === 0) return
      const last = messages[messages.length - 1]
      const newHidden = !last.extra?.hidden
      try {
        const updated = await messagesApi.update(activeChatId, last.id, {
          extra: { ...last.extra, hidden: newHidden },
        })
        useStore.getState().updateMessage(updated.id, updated)
        addToast({
          type: 'success',
          message: newHidden ? tc('toast.messageHidden') : tc('toast.messageVisible'),
        })
      } catch {
        addToast({ type: 'error', message: tc('toast.failedUpdateMessage') })
      }
    },
  },

  {
    id: 'action-dry-run',
    label: 'Preview Prompt',
    description: 'Dry-run to see the assembled prompt and token count',
    icon: Eye,
    keywords: ['dry run', 'preview', 'prompt', 'tokens', 'assembly', 'debug'],
    group: 'actions',
    scope: 'chat-idle',
    run: async () => {
      const {
        activeChatId,
        activeProfileId,
        activePersonaId,
        activeCharacterId,
        activeGroupCharacterId,
        getActivePresetForGeneration,
        openModal,
        addToast,
      } = useStore.getState()
      if (!activeChatId) return
      try {
        const presetId = getActivePresetForGeneration() || undefined
        const result = await generateApi.dryRun({
          chat_id: activeChatId,
          connection_id: activeProfileId || undefined,
          persona_id: activePersonaId || undefined,
          preset_id: presetId,
          force_preset_id: shouldForceLoomRuntimePreset(presetId, activeChatId, activeCharacterId, activeProfileId),
          target_character_id: activeGroupCharacterId ?? activeCharacterId ?? undefined,
        })

        openModal('dryRun', result)
      } catch (err: any) {
        addToast({ type: 'error', message: err?.body?.error || tc('toast.dryRunFailed') })
      }
    },
  },

  {
    id: 'action-edit-character',
    label: 'Edit Character',
    description: 'Open the character editor for the current character',
    icon: Edit3,
    keywords: ['edit', 'character', 'modify', 'update', 'profile'],
    group: 'actions',
    scope: 'character',
    run: (navigate) => {
      const { activeCharacterId } = useStore.getState()
      if (!activeCharacterId) return
      navigate(`/characters/${activeCharacterId}`)
    },
  },
  {
    id: 'action-duplicate-character',
    label: 'Duplicate Character',
    description: 'Create a copy of the current character',
    icon: Copy,
    keywords: ['duplicate', 'clone', 'copy', 'character'],
    group: 'actions',
    scope: 'character',
    run: async () => {
      const { activeCharacterId, addToast } = useStore.getState()
      if (!activeCharacterId) return
      try {
        const dup = await charactersApi.duplicate(activeCharacterId)
        addToast({ type: 'success', message: tc('toast.duplicatedCharacter', { name: dup.name }) })
      } catch {
        addToast({ type: 'error', message: tc('toast.failedDuplicateCharacter') })
      }
    },
  },

  {
    id: 'action-toggle-portrait',
    label: 'Toggle Portrait Panel',
    description: 'Show or hide the character portrait sidebar',
    icon: Columns,
    keywords: ['portrait', 'panel', 'sidebar', 'toggle', 'character', 'image'],
    group: 'actions',
    scope: 'chat',
    run: () => {
      useStore.getState().togglePortraitPanel()
    },
  },

  {
    id: 'action-delete-chat',
    label: 'Delete Chat',
    description: 'Permanently delete this conversation',
    icon: Trash2,
    keywords: ['delete', 'remove', 'destroy', 'chat', 'conversation'],
    group: 'actions',
    scope: 'chat',
    run: (navigate) => {
      const { activeChatId, openModal, addToast } = useStore.getState()
      if (!activeChatId) return
      openModal('confirm', {
        title: tc('confirm.deleteChat.title'),
        message: tc('confirm.deleteChat.message'),
        variant: 'danger',
        confirmText: tc('confirm.deleteChat.confirm'),
        onConfirm: async () => {
          try {
            await chatsApi.delete(activeChatId)
            addToast({ type: 'success', message: tc('toast.chatDeleted') })
            navigate('/')
          } catch {
            addToast({ type: 'error', message: tc('toast.failedDeleteChat') })
          }
        },
      })
    },
  },

  // Panels — auto-generated from the drawer tab registry
  ...registryToCommands(DRAWER_TABS),

]

/** Build the full command list including role-aware settings entries. */
export function buildCommands(userRole?: string): Command[] {
  const settingsTabs = getVisibleSettingsTabs(userRole)
  return [...COMMANDS, ...settingsRegistryToCommands(settingsTabs)]
}
