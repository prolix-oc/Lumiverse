import type { ComponentType, ReactNode } from 'react'
import {
  Sliders, MessageSquare, Users, PanelRight,
  Compass, Reply, HardDrive, Puzzle, Database, Hash, Activity,
  Globe, Bell, Import, Brain, Terminal, Volume2, Plug,
} from 'lucide-react'
import { useStore } from '@/store'
import type { Command, CommandScope } from '@/lib/commands'

export interface SettingsTabEntry {
  /** Unique view id used by the store's settingsActiveView */
  id: string
  /** Short label shown in the settings sidebar */
  shortName: string
  /** Full title shown in the command palette listing */
  tabName: string
  /** Description shown in the command palette */
  tabDescription: string
  /** Icon component for sidebar and command palette */
  tabIcon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>
  /** Keywords for command palette fuzzy search */
  keywords: string[]
  /** Optional scope restriction for command palette filtering */
  scope?: CommandScope
  /** Access restriction — omit for all users */
  role?: 'admin' | 'owner'
  /** React component factory to render the settings content */
  component: () => ReactNode
}

// Settings view components are rendered by the SettingsView switch in SettingsModal.tsx.
// The component field here is a placeholder — only the id, icon, and metadata are used
// by the sidebar nav and command palette integration.
const INLINE_SENTINEL = () => null

export const SETTINGS_TABS: SettingsTabEntry[] = [
  {
    id: 'display',
    shortName: 'Display',
    tabName: 'Display & Layout',
    tabDescription: 'Panel width, sidebar position, and layout options',
    tabIcon: PanelRight,
    keywords: ['display', 'layout', 'sidebar', 'drawer', 'width', 'panel', 'position', 'modal', 'chat heads'],
    component: INLINE_SENTINEL,
  },
  {
    id: 'chat',
    shortName: 'Chat',
    tabName: 'Chat Behavior',
    tabDescription: 'Message display mode, send key, and chat options',
    tabIcon: MessageSquare,
    keywords: ['chat', 'behavior', 'enter to send', 'bubble', 'minimal', 'immersive', 'streaming', 'message'],
    component: INLINE_SENTINEL,
  },
  {
    id: 'extensions',
    shortName: 'Extensions',
    tabName: 'Extension Settings',
    tabDescription: 'Manage Spindle extension configuration',
    tabIcon: Puzzle,
    keywords: ['extensions', 'spindle', 'plugins', 'addons', 'settings'],
    component: INLINE_SENTINEL,
  },
  {
    id: 'guided',
    shortName: 'Guided Gen',
    tabName: 'Guided Generation',
    tabDescription: 'Configure guided generation sequences and prompt biases',
    tabIcon: Compass,
    keywords: ['guided', 'generation', 'sequences', 'bias', 'prompt', 'persistent'],
    component: INLINE_SENTINEL,
  },
  {
    id: 'quickReplies',
    shortName: 'Quick Replies',
    tabName: 'Quick Replies',
    tabDescription: 'Manage quick reply sets and message shortcuts',
    tabIcon: Reply,
    keywords: ['quick replies', 'shortcuts', 'messages', 'macros', 'quick'],
    component: INLINE_SENTINEL,
  },
  {
    id: 'extensionPools',
    shortName: 'Extension Pools',
    tabName: 'Extension Pools',
    tabDescription: 'Configure extension resource pool limits',
    tabIcon: HardDrive,
    keywords: ['extension', 'pools', 'resources', 'limits', 'storage'],
    component: INLINE_SENTINEL,
  },
  {
    id: 'embeddings',
    shortName: 'Embeddings',
    tabName: 'Embeddings',
    tabDescription: 'Configure embedding models and vector storage',
    tabIcon: Database,
    keywords: ['embeddings', 'vectors', 'semantic', 'search', 'similarity', 'database', 'memory'],
    component: INLINE_SENTINEL,
  },
  {
    id: 'memoryCortex',
    shortName: 'Memory Cortex',
    tabName: 'Memory Cortex Settings',
    tabDescription: 'Configure memory cortex extraction and salience',
    tabIcon: Brain,
    keywords: ['memory', 'cortex', 'entities', 'relations', 'salience', 'extraction', 'brain', 'recall'],
    component: INLINE_SENTINEL,
  },
  {
    id: 'notifications',
    shortName: 'Notifications',
    tabName: 'Notifications',
    tabDescription: 'Configure notification preferences and alerts',
    tabIcon: Bell,
    keywords: ['notifications', 'alerts', 'sounds', 'push', 'desktop', 'bell'],
    component: INLINE_SENTINEL,
  },
  {
    id: 'voice',
    shortName: 'Voice',
    tabName: 'Voice & Speech',
    tabDescription: 'Text-to-speech, speech-to-text, and voice settings',
    tabIcon: Volume2,
    keywords: ['voice', 'speech', 'tts', 'stt', 'text to speech', 'speech to text', 'microphone', 'audio', 'speak', 'whisper'],
    component: INLINE_SENTINEL,
  },
  {
    id: 'mcpServers',
    shortName: 'MCP Servers',
    tabName: 'MCP Servers',
    tabDescription: 'Connect to external MCP tool servers for function calling',
    tabIcon: Plug,
    keywords: ['mcp', 'tools', 'servers', 'model context protocol', 'function calling', 'external'],
    component: INLINE_SENTINEL,
  },
  {
    id: 'advanced',
    shortName: 'Advanced',
    tabName: 'Advanced Settings',
    tabDescription: 'Advanced configuration and debug options',
    tabIcon: Sliders,
    keywords: ['advanced', 'debug', 'config', 'technical', 'expert', 'context filters', 'reasoning'],
    component: INLINE_SENTINEL,
  },
  {
    id: 'lumihub',
    shortName: 'LumiHub',
    tabName: 'LumiHub',
    tabDescription: 'LumiHub cloud sync and sharing settings',
    tabIcon: Globe,
    keywords: ['lumihub', 'cloud', 'sync', 'sharing', 'online', 'hub'],
    component: INLINE_SENTINEL,
  },
  {
    id: 'diagnostics',
    shortName: 'Diagnostics',
    tabName: 'Diagnostics',
    tabDescription: 'System health, performance metrics, and debug info',
    tabIcon: Activity,
    keywords: ['diagnostics', 'health', 'performance', 'debug', 'info', 'system', 'status', 'metrics'],
    component: INLINE_SENTINEL,
  },

  // ── Admin/Owner-gated tabs ────────────────────────────────────────────────────

  {
    id: 'operator',
    shortName: 'Operator',
    tabName: 'Operator Panel',
    tabDescription: 'Server management, updates, and restart controls',
    tabIcon: Terminal,
    keywords: ['operator', 'server', 'restart', 'update', 'git', 'branch', 'logs', 'admin'],
    role: 'owner',
    component: INLINE_SENTINEL,
  },
  {
    id: 'tokenizers',
    shortName: 'Tokenizers',
    tabName: 'Tokenizer Manager',
    tabDescription: 'Manage and test tokenizer configurations',
    tabIcon: Hash,
    keywords: ['tokenizer', 'tokens', 'count', 'encoding', 'tiktoken', 'bpe'],
    role: 'admin',
    component: INLINE_SENTINEL,
  },
  {
    id: 'users',
    shortName: 'Users',
    tabName: 'User Management',
    tabDescription: 'Manage user accounts, roles, and permissions',
    tabIcon: Users,
    keywords: ['users', 'accounts', 'roles', 'permissions', 'admin', 'management'],
    role: 'admin',
    component: INLINE_SENTINEL,
  },
  {
    id: 'migration',
    shortName: 'Migration',
    tabName: 'Migration',
    tabDescription: 'Import data from SillyTavern and other sources',
    tabIcon: Import,
    keywords: ['migration', 'import', 'sillytavern', 'transfer', 'data', 'convert'],
    role: 'admin',
    component: INLINE_SENTINEL,
  },
]

/** Filter settings tabs based on current user role. */
export function getVisibleSettingsTabs(userRole?: string): SettingsTabEntry[] {
  const isOwner = userRole === 'owner'
  const isAdmin = isOwner || userRole === 'admin'

  return SETTINGS_TABS.filter((tab) => {
    if (!tab.role) return true
    if (tab.role === 'owner') return isOwner
    if (tab.role === 'admin') return isAdmin
    return false
  })
}

/** Generate Settings commands from the registry for the command palette. */
export function settingsRegistryToCommands(entries: SettingsTabEntry[]): Command[] {
  return entries.map((entry) => ({
    id: `settings-${entry.id}`,
    label: entry.tabName,
    description: entry.tabDescription,
    icon: entry.tabIcon,
    keywords: entry.keywords,
    group: 'Settings' as const,
    scope: entry.scope,
    run: () => useStore.getState().openSettings(entry.id),
  }))
}
