import type { NavigateFunction } from 'react-router'
import type { ComponentType } from 'react'
import {
  Settings, PanelRight, MessageSquare, Compass, Reply, Sliders,
  Plus, RotateCw, CornerDownLeft, Trash2, Edit3, Copy,
  Eye, EyeOff, Columns, FolderOpen, ClipboardCopy, Upload, Search,
  GitBranch, Palette,
} from 'lucide-react'
import { useStore } from '@/store'
import { chatsApi, messagesApi } from '@/api/chats'
import { generateApi } from '@/api/generate'
import { charactersApi } from '@/api/characters'
import { DRAWER_TABS, registryToCommands } from '@/lib/drawer-tab-registry'

export type CommandScope = 'global' | 'chat' | 'chat-idle' | 'landing' | 'character'

export interface Command {
  id: string
  label: string
  description: string
  icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>
  keywords: string[]
  group: 'Actions' | 'Panels' | 'Settings' | 'Extensions'
  scope?: CommandScope
  run: (navigate: NavigateFunction) => void | Promise<void>
}

export const GROUP_ORDER: Command['group'][] = ['Actions', 'Panels', 'Settings', 'Extensions']

function openSettingsView(view: string) {
  useStore.getState().openSettings(view)
}

export const COMMANDS: Command[] = [


  {
    id: 'action-regenerate',
    label: 'Regenerate Response',
    description: 'Delete the last AI reply and generate a new one',
    icon: RotateCw,
    keywords: ['regenerate', 'retry', 'redo', 'reroll', 'response'],
    group: 'Actions',
    scope: 'chat-idle',
    run: async () => {
      const { activeChatId, activeProfileId, activePersonaId, getActivePresetForGeneration, beginStreaming, startStreaming, setStreamingError, addToast } = useStore.getState()
      if (!activeChatId) return
      beginStreaming()
      try {
        const res = await generateApi.regenerate({
          chat_id: activeChatId,
          connection_id: activeProfileId || undefined,
          persona_id: activePersonaId || undefined,
          preset_id: getActivePresetForGeneration() || undefined,
          generation_type: 'regenerate',
        })
        startStreaming(res.generationId)
      } catch (err: any) {
        const msg = err?.body?.error || err?.message || 'Failed to regenerate'
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
    group: 'Actions',
    scope: 'chat-idle',
    run: async () => {
      const { activeChatId, activeProfileId, activePersonaId, getActivePresetForGeneration, beginStreaming, startStreaming, setStreamingError, addToast } = useStore.getState()
      if (!activeChatId) return
      beginStreaming()
      try {
        const res = await generateApi.continueGeneration({
          chat_id: activeChatId,
          connection_id: activeProfileId || undefined,
          persona_id: activePersonaId || undefined,
          preset_id: getActivePresetForGeneration() || undefined,
        })

        startStreaming(res.generationId)
      } catch (err: any) {
        const msg = err?.body?.error || err?.message || 'Failed to continue'
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
    group: 'Actions',
    scope: 'global',
    run: (navigate) => navigate('/'),
  },
  {
    id: 'action-character-browser',
    label: 'Browse Characters',
    description: 'Open the full character library',
    icon: Search,
    keywords: ['characters', 'library', 'browse', 'list', 'cards'],
    group: 'Actions',
    scope: 'global',
    run: (navigate) => navigate('/characters'),
  },
  {
    id: 'action-import-character',
    label: 'Import Character',
    description: 'Upload a character card (.png, .webp, .json)',
    icon: Upload,
    keywords: ['import', 'upload', 'card', 'character', 'file'],
    group: 'Actions',
    scope: 'global',
    run: async () => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.png,.webp,.json'
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0]
        if (!file) return
        const { addToast } = useStore.getState()
        try {
          const res = await charactersApi.importFile(file)
          addToast({ type: 'success', message: `Imported "${res.character.name}"` })
        } catch (err: any) {
          addToast({ type: 'error', message: err?.body?.error || 'Failed to import character' })
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
    group: 'Actions',
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
    group: 'Actions',
    scope: 'chat-idle',
    run: async (navigate) => {
      const store = useStore.getState()
      const { activeChatId, messages } = store
      if (!activeChatId || messages.length === 0) return
      const lastMessage = messages[messages.length - 1]
      store.openModal('confirm', {
        title: 'Fork Chat',
        message: 'Create a new branch at the latest message?',
        confirmText: 'Fork',
        onConfirm: async () => {
          try {
            const newChat = await chatsApi.branch(activeChatId, lastMessage.id)
            navigate(`/chat/${newChat.id}`)
          } catch {
            useStore.getState().addToast({ type: 'error', message: 'Failed to fork chat.' })
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
    group: 'Actions',
    scope: 'chat',
    run: () => {
      const { activeCharacterId, characters, openModal } = useStore.getState()
      if (!activeCharacterId) return
      const char = characters.find((c) => c.id === activeCharacterId)
      openModal('manageChats', {
        characterId: activeCharacterId,
        characterName: char?.name || 'Character',
      })
    },
  },

  {
    id: 'action-copy-last-message',
    label: 'Copy Last Message',
    description: 'Copy the most recent message to clipboard',
    icon: ClipboardCopy,
    keywords: ['copy', 'clipboard', 'last', 'message', 'response'],
    group: 'Actions',
    scope: 'chat',
    run: async () => {
      const { messages, addToast } = useStore.getState()
      if (messages.length === 0) return
      const last = messages[messages.length - 1]
      try {
        await navigator.clipboard.writeText(last.content)
        addToast({ type: 'success', message: 'Copied to clipboard' })
      } catch {
        addToast({ type: 'error', message: 'Failed to copy' })
      }
    },
  },
  {
    id: 'action-delete-last-message',
    label: 'Delete Last Message',
    description: 'Remove the most recent message from this chat',
    icon: Trash2,
    keywords: ['delete', 'remove', 'last', 'message', 'undo'],
    group: 'Actions',
    scope: 'chat-idle',
    run: async () => {
      const { activeChatId, messages, removeMessage, addToast } = useStore.getState()
      if (!activeChatId || messages.length === 0) return
      const last = messages[messages.length - 1]
      try {
        await messagesApi.delete(activeChatId, last.id)
        removeMessage(last.id)
        addToast({ type: 'success', message: 'Message deleted' })
      } catch {
        addToast({ type: 'error', message: 'Failed to delete message' })
      }
    },
  },
  {
    id: 'action-toggle-hidden-last',
    label: 'Toggle Hide Last Message',
    description: 'Show or hide the last message from AI context',
    icon: EyeOff,
    keywords: ['hide', 'hidden', 'toggle', 'context', 'message', 'exclude'],
    group: 'Actions',
    scope: 'chat-idle',
    run: async () => {
      const { activeChatId, messages, updateMessage, addToast } = useStore.getState()
      if (!activeChatId || messages.length === 0) return
      const last = messages[messages.length - 1]
      const newHidden = !last.extra?.hidden
      try {
        await messagesApi.update(activeChatId, last.id, {
          extra: { ...last.extra, hidden: newHidden },
        })
        updateMessage(last.id, { extra: { ...last.extra, hidden: newHidden } })
        addToast({ type: 'success', message: newHidden ? 'Message hidden from context' : 'Message visible in context' })
      } catch {
        addToast({ type: 'error', message: 'Failed to update message' })
      }
    },
  },

  {
    id: 'action-dry-run',
    label: 'Preview Prompt',
    description: 'Dry-run to see the assembled prompt and token count',
    icon: Eye,
    keywords: ['dry run', 'preview', 'prompt', 'tokens', 'assembly', 'debug'],
    group: 'Actions',
    scope: 'chat-idle',
    run: async () => {
      const { activeChatId, activeProfileId, activePersonaId, getActivePresetForGeneration, openModal, addToast } = useStore.getState()
      if (!activeChatId) return
      try {
        const result = await generateApi.dryRun({
          chat_id: activeChatId,
          connection_id: activeProfileId || undefined,
          persona_id: activePersonaId || undefined,
          preset_id: getActivePresetForGeneration() || undefined,
        })

        openModal('dryRun', result)
      } catch (err: any) {
        addToast({ type: 'error', message: err?.body?.error || 'Dry run failed' })
      }
    },
  },

  {
    id: 'action-edit-character',
    label: 'Edit Character',
    description: 'Open the character editor for the current character',
    icon: Edit3,
    keywords: ['edit', 'character', 'modify', 'update', 'profile'],
    group: 'Actions',
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
    group: 'Actions',
    scope: 'character',
    run: async () => {
      const { activeCharacterId, addToast } = useStore.getState()
      if (!activeCharacterId) return
      try {
        const dup = await charactersApi.duplicate(activeCharacterId)
        addToast({ type: 'success', message: `Duplicated as "${dup.name}"` })
      } catch {
        addToast({ type: 'error', message: 'Failed to duplicate character' })
      }
    },
  },

  {
    id: 'action-toggle-portrait',
    label: 'Toggle Portrait Panel',
    description: 'Show or hide the character portrait sidebar',
    icon: Columns,
    keywords: ['portrait', 'panel', 'sidebar', 'toggle', 'character', 'image'],
    group: 'Actions',
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
    group: 'Actions',
    scope: 'chat',
    run: (navigate) => {
      const { activeChatId, openModal, addToast } = useStore.getState()
      if (!activeChatId) return
      openModal('confirm', {
        title: 'Delete Chat',
        message: 'This will permanently delete this conversation and all its messages.',
        variant: 'danger',
        confirmText: 'Delete',
        onConfirm: async () => {
          try {
            await chatsApi.delete(activeChatId)
            addToast({ type: 'success', message: 'Chat deleted' })
            navigate('/')
          } catch {
            addToast({ type: 'error', message: 'Failed to delete chat' })
          }
        },
      })
    },
  },

  // Panels — auto-generated from the drawer tab registry
  ...registryToCommands(DRAWER_TABS),

  // Settings
  {
    id: 'settings-general',
    label: 'General Settings',
    description: 'Application preferences and defaults',
    icon: Settings,
    keywords: ['settings', 'general', 'preferences', 'defaults', 'landing page'],
    group: 'Settings',
    run: () => openSettingsView('general'),
  },
  {
    id: 'settings-display',
    label: 'Display & Layout',
    description: 'Panel width, sidebar position, and layout options',
    icon: PanelRight,
    keywords: ['display', 'layout', 'sidebar', 'drawer', 'width', 'panel', 'position'],
    group: 'Settings',
    run: () => openSettingsView('display'),
  },
  {
    id: 'settings-chat',
    label: 'Chat Behavior',
    description: 'Message display mode, send key, and chat options',
    icon: MessageSquare,
    keywords: ['chat', 'behavior', 'enter to send', 'bubble', 'minimal', 'immersive'],
    group: 'Settings',
    run: () => openSettingsView('chat'),
  },
  {
    id: 'settings-appearance',
    label: 'Appearance',
    description: 'Theme presets and advanced visual configuration',
    icon: Palette,
    keywords: ['appearance', 'theme', 'colors', 'font', 'visual', 'style'],
    group: 'Settings',
    run: () => openSettingsView('appearance'),
  },
  {
    id: 'settings-guided',
    label: 'Guided Generation',
    description: 'Configure guided generation sequences and prompt biases',
    icon: Compass,
    keywords: ['guided', 'generation', 'sequences', 'bias', 'prompt', 'persistent'],
    group: 'Settings',
    run: () => openSettingsView('guided'),
  },
  {
    id: 'settings-quickreplies',
    label: 'Quick Replies',
    description: 'Manage quick reply sets and message shortcuts',
    icon: Reply,
    keywords: ['quick replies', 'shortcuts', 'messages', 'macros', 'quick'],
    group: 'Settings',
    run: () => openSettingsView('quickReplies'),
  },
  {
    id: 'settings-advanced',
    label: 'Advanced Settings',
    description: 'Advanced configuration and debug options',
    icon: Sliders,
    keywords: ['advanced', 'debug', 'config', 'technical', 'expert'],
    group: 'Settings',
    run: () => openSettingsView('advanced'),
  },
]