import type { NavigateFunction } from 'react-router'
import type { ComponentType } from 'react'
import {
  User, Wand2, GitFork, Link2, Package, Users, Drama, Library,
  PenTool, MessageCircle, FileText, Brain, ScrollText, MessageSquareReply,
  Globe, Image, GitBranch, Palette, Puzzle,
  Settings, PanelRight, MessageSquare, Compass, Reply, Sliders,
  Plus,
} from 'lucide-react'
import { useStore } from '@/store'
import { chatsApi } from '@/api/chats'

export interface Command {
  id: string
  label: string
  description: string
  icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>
  keywords: string[]
  group: 'Panels' | 'Settings' | 'Actions' | 'Extensions'
  /** Return false to hide this command. Called at filter time, not at registration. */
  isAvailable?: () => boolean
  run: (navigate: NavigateFunction) => void | Promise<void>
}

export const GROUP_ORDER: Command['group'][] = ['Panels', 'Settings', 'Actions', 'Extensions']

function openPanel(tabId: string) {
  useStore.getState().openDrawer(tabId)
}

function openSettingsView(view: string) {
  useStore.getState().openSettings(view)
}

export const COMMANDS: Command[] = [

  // Panels
  {
    id: 'panel-profile',
    label: 'Profile',
    description: 'View and edit the active character',
    icon: User,
    keywords: ['character', 'avatar', 'info', 'edit'],
    group: 'Panels',
    run: () => openPanel('profile'),
  },
  {
    id: 'panel-presets',
    label: 'Reasoning',
    description: 'Manage generation presets and parameters',
    icon: Wand2,
    keywords: ['presets', 'parameters', 'temperature', 'sampler', 'generation', 'reasoning'],
    group: 'Panels',
    run: () => openPanel('presets'),
  },
  {
    id: 'panel-loom',
    label: 'Loom',
    description: 'Configure narrative structure and story beats',
    icon: GitFork,
    keywords: ['narrative', 'story', 'lore', 'structure', 'beats'],
    group: 'Panels',
    run: () => openPanel('loom'),
  },
  {
    id: 'panel-connections',
    label: 'Connections',
    description: 'Manage API connections and providers',
    icon: Link2,
    keywords: ['api', 'provider', 'key', 'openai', 'anthropic', 'model', 'endpoint'],
    group: 'Panels',
    run: () => openPanel('connections'),
  },
  {
    id: 'panel-browser',
    label: 'Pack Browser',
    description: 'Browse and manage content packs',
    icon: Package,
    keywords: ['packs', 'content', 'download', 'browse', 'browser'],
    group: 'Panels',
    run: () => openPanel('browser'),
  },
  {
    id: 'panel-characters',
    label: 'Characters',
    description: 'Browse and manage your character cards',
    icon: Users,
    keywords: ['character', 'list', 'import', 'card', 'browse'],
    group: 'Panels',
    run: () => openPanel('characters'),
  },
  {
    id: 'panel-personas',
    label: 'Personas',
    description: 'Manage your user personas',
    icon: Drama,
    keywords: ['persona', 'identity', 'user', 'avatar'],
    group: 'Panels',
    run: () => openPanel('personas'),
  },
  {
    id: 'panel-lorebook',
    label: 'Lorebook',
    description: 'Edit world book and lorebook entries',
    icon: Library,
    keywords: ['lorebook', 'world', 'lore', 'book', 'entries', 'worldbook'],
    group: 'Panels',
    run: () => openPanel('lorebook'),
  },
  {
    id: 'panel-create',
    label: 'Creator Workshop',
    description: 'Create and edit Lumia items and Loom presets',
    icon: PenTool,
    keywords: ['create', 'workshop', 'editor', 'build', 'new', 'lumia', 'loom'],
    group: 'Panels',
    run: () => openPanel('create'),
  },
  {
    id: 'panel-ooc',
    label: 'OOC',
    description: 'Out-of-character comment display settings',
    icon: MessageCircle,
    keywords: ['ooc', 'out of character', 'comments', 'irc', 'social'],
    group: 'Panels',
    run: () => openPanel('ooc'),
  },
  {
    id: 'panel-prompt',
    label: 'Prompt Inspector',
    description: 'View the assembled prompt and token breakdown',
    icon: FileText,
    keywords: ['prompt', 'context', 'tokens', 'breakdown', 'inspect', 'debug'],
    group: 'Panels',
    run: () => openPanel('prompt'),
  },
  {
    id: 'panel-council',
    label: 'Council',
    description: 'Configure the Lumia Council and tool functions',
    icon: Brain,
    keywords: ['council', 'tools', 'agents', 'lumia', 'functions', 'tool use'],
    group: 'Panels',
    run: () => openPanel('council'),
  },
  {
    id: 'panel-summary',
    label: 'Summary',
    description: 'Configure context summarization and truncation',
    icon: ScrollText,
    keywords: ['summary', 'context', 'truncation', 'compress', 'summarize'],
    group: 'Panels',
    run: () => openPanel('summary'),
  },
  {
    id: 'panel-feedback',
    label: 'Council Feedback',
    description: 'View the latest council execution results',
    icon: MessageSquareReply,
    keywords: ['feedback', 'council', 'results', 'tools', 'output', 'debug'],
    group: 'Panels',
    run: () => openPanel('feedback'),
  },
  {
    id: 'panel-worldinfo',
    label: 'World Info',
    description: 'View currently activated world info entries',
    icon: Globe,
    keywords: ['world info', 'activation', 'lorebook', 'active', 'entries'],
    group: 'Panels',
    run: () => openPanel('worldinfo'),
  },
  {
    id: 'panel-imagegen',
    label: 'Image Generation',
    description: 'Configure and control AI scene generation',
    icon: Image,
    keywords: ['image', 'generation', 'scene', 'art', 'picture', 'ai', 'background'],
    group: 'Panels',
    run: () => openPanel('imagegen'),
  },
  {
    id: 'panel-branches',
    label: 'Branch Tree',
    description: 'View and navigate the chat branch history',
    icon: GitBranch,
    keywords: ['branch', 'fork', 'history', 'tree', 'navigate', 'alternate'],
    group: 'Panels',
    run: () => openPanel('branches'),
  },
  {
    id: 'panel-theme',
    label: 'Theme',
    description: 'Customize colors, accent, and visual style',
    icon: Palette,
    keywords: ['theme', 'colors', 'accent', 'appearance', 'dark', 'light', 'glass', 'radius'],
    group: 'Panels',
    run: () => openPanel('theme'),
  },
  {
    id: 'panel-spindle',
    label: 'Extensions',
    description: 'Manage Spindle extensions',
    icon: Puzzle,
    keywords: ['extensions', 'spindle', 'plugins', 'addons', 'install'],
    group: 'Panels',
    run: () => openPanel('spindle'),
  },

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

  // Actions
  {
    id: 'action-new-chat',
    label: 'New Chat',
    description: 'Go to the home screen to start a new conversation',
    icon: Plus,
    keywords: ['new', 'chat', 'start', 'home', 'begin', 'create'],
    group: 'Actions',
    run: (navigate) => navigate('/'),
  },
  {
    id: 'action-fork-chat',
    label: 'Fork Chat',
    description: 'Branch the current chat at the latest message',
    icon: GitBranch,
    keywords: ['fork', 'branch', 'split', 'alternate', 'copy', 'diverge'],
    group: 'Actions',
    isAvailable: () => {
      const { activeChatId, messages } = useStore.getState()
      return !!activeChatId && messages.length > 0
    },
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
]
