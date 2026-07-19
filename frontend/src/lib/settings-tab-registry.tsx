import type { ComponentType, ReactNode } from 'react'
import {
  Sliders, MessageSquare, Users, PanelRight,
  Compass, Reply, HardDrive, Puzzle, Database, Hash, Activity,
  Globe, Bell, Import, Brain, Terminal, Volume2, Plug, Search, UserRound,
  PackageOpen, KeyRound,
} from 'lucide-react'
import { useStore } from '@/store'
import { translateSettingsField, translateSettingsSectionTitle } from '@/lib/i18n/resolveLabel'
import type { Command, CommandScope } from '@/lib/commands'

/**
 * A searchable, scroll-to-able section within a settings tab. The `key` is combined
 * with the tab id to form a stable DOM anchor (see {@link sectionAnchorId}) that is
 * attached to the matching `<h3>` heading in SettingsModal. Tabs with no `sections`
 * are still searchable at the tab level (the search falls back to scrolling to top).
 */
export interface SettingsSection {
  /** Anchor key, unique within the tab (e.g. 'swipe'). */
  key: string
  /** Existing i18n key (settings ns) for the section title, e.g. 'chat.widthTitle'. */
  titleKey: string
  /** English fallback title, mirrors the heading text. */
  titleFallback: string
  /** Extra keywords for in-modal search, merged with the tab keywords. */
  keywords: string[]
}

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
  /** Searchable sections within the tab, for the in-modal settings search. */
  sections?: SettingsSection[]
  /** React component factory to render the settings content */
  component: () => ReactNode
}

// Settings view components are rendered by the SettingsView switch in SettingsModal.tsx.
// The component field here is a placeholder — only the id, icon, and metadata are used
// by the sidebar nav and command palette integration.
const INLINE_SENTINEL = () => null

export const SETTINGS_TABS: SettingsTabEntry[] = [
  {
    id: 'account',
    shortName: 'Account',
    tabName: 'Account Settings',
    tabDescription: 'Manage your account details and password',
    tabIcon: UserRound,
    keywords: ['account', 'profile', 'password', 'credentials', 'security', 'me'],
    component: INLINE_SENTINEL,
  },
  {
    id: 'display',
    shortName: 'Display',
    tabName: 'Display & Layout',
    tabDescription: 'Panel width, sidebar position, and layout options',
    tabIcon: PanelRight,
    keywords: ['display', 'layout', 'sidebar', 'drawer', 'width', 'panel', 'position', 'modal', 'chat heads'],
    sections: [
      { key: 'modalWidth', titleKey: 'display.modalWidth.title', titleFallback: 'Modal Width', keywords: ['modal width', 'width', 'max width', 'full', 'comfortable', 'compact', 'custom'] },
      { key: 'drawer', titleKey: 'display.drawer.title', titleFallback: 'Drawer', keywords: ['drawer', 'sidebar', 'side', 'panel width', 'tab position', 'tab size', 'tab labels'] },
      { key: 'toast', titleKey: 'display.toast.title', titleFallback: 'Notifications', keywords: ['toast', 'toast position', 'popup position', 'alert position'] },
      { key: 'chatHeads', titleKey: 'display.chatHeads.title', titleFallback: 'Chat Heads', keywords: ['chat heads', 'heads', 'floating avatar', 'completion sound', 'opacity', 'size', 'direction'] },
      { key: 'landing', titleKey: 'display.landing.title', titleFallback: 'Pagination', keywords: ['landing', 'pagination', 'recent chats', 'chats displayed', 'layout', 'page size'] },
    ],
    component: INLINE_SENTINEL,
  },
  {
    id: 'chat',
    shortName: 'Chat',
    tabName: 'Chat Behavior',
    tabDescription: 'Message display mode, send key, and chat options',
    tabIcon: MessageSquare,
    keywords: ['chat', 'behavior', 'enter to send', 'bubble', 'minimal', 'immersive', 'streaming', 'message'],
    sections: [
      { key: 'general', titleKey: 'chat.title', titleFallback: 'Chat', keywords: ['message display', 'display mode', 'bubble', 'minimal', 'immersive', 'enter to send', 'streaming', 'markdown'] },
      { key: 'width', titleKey: 'chat.widthTitle', titleFallback: 'Chat Width', keywords: ['chat width', 'content width', 'message width'] },
      { key: 'messagesPerPage', titleKey: 'chat.messagesPerPageTitle', titleFallback: 'Messages Per Page', keywords: ['messages per page', 'pagination', 'page size', 'load more'] },
      { key: 'input', titleKey: 'chat.inputTitle', titleFallback: 'Input', keywords: ['input', 'composer', 'textarea', 'send', 'enter key'] },
      { key: 'regen', titleKey: 'chat.regenTitle', titleFallback: 'Regeneration Feedback', keywords: ['regeneration', 'regen', 'feedback', 'swipe regenerate'] },
      { key: 'messageInfo', titleKey: 'chat.messageInfoTitle', titleFallback: 'Message Info', keywords: ['message info', 'timestamp', 'token count', 'metadata'] },
      { key: 'swipe', titleKey: 'chat.swipeTitle', titleFallback: 'Swipe Navigation', keywords: ['swipe', 'swipe navigation', 'alternate responses', 'variations'] },
    ],
    component: INLINE_SENTINEL,
  },
  {
    id: 'extensions',
    shortName: 'Extensions',
    tabName: 'Extension Settings',
    tabDescription: 'Manage Spindle extension configuration',
    tabIcon: Puzzle,
    keywords: ['extensions', 'spindle', 'plugins', 'addons', 'settings'],
    sections: [
      { key: 'general', titleKey: 'extensions.title', titleFallback: 'Extension Settings', keywords: ['extensions', 'spindle', 'plugins', 'addons'] },
    ],
    component: INLINE_SENTINEL,
  },
  {
    id: 'guided',
    shortName: 'Guided Gen',
    tabName: 'Guided Generation',
    tabDescription: 'Configure guided generation sequences and prompt biases',
    tabIcon: Compass,
    keywords: ['guided', 'generation', 'sequences', 'bias', 'prompt', 'persistent'],
    sections: [
      { key: 'general', titleKey: 'guided.title', titleFallback: 'Guided Generations', keywords: ['guided generation', 'sequences', 'bias', 'persistent', 'prompt'] },
    ],
    component: INLINE_SENTINEL,
  },
  {
    id: 'quickReplies',
    shortName: 'Quick Replies',
    tabName: 'Quick Replies',
    tabDescription: 'Manage quick reply sets and message shortcuts',
    tabIcon: Reply,
    keywords: ['quick replies', 'shortcuts', 'messages', 'macros', 'quick'],
    sections: [
      { key: 'general', titleKey: 'quickReplies.title', titleFallback: 'Quick Replies', keywords: ['quick replies', 'shortcuts', 'macros', 'message shortcuts'] },
    ],
    component: INLINE_SENTINEL,
  },
  {
    id: 'extensionPools',
    shortName: 'Extension Pools',
    tabName: 'Extension Pools',
    tabDescription: 'Configure extension resource pool limits',
    tabIcon: HardDrive,
    keywords: ['extension', 'pools', 'resources', 'limits', 'storage'],
    sections: [
      { key: 'general', titleKey: 'extensionPools.title', titleFallback: 'Extension Ephemeral Pools', keywords: ['extension pools', 'ephemeral', 'resource limits', 'storage', 'quota'] },
    ],
    component: INLINE_SENTINEL,
  },
  {
    id: 'webSearch',
    shortName: 'Web Search',
    tabName: 'Web Search',
    tabDescription: 'Configure SearXNG-backed web search for council tools',
    tabIcon: Search,
    keywords: ['web search', 'searxng', 'search', 'browse', 'internet', 'web', 'council tool'],
    sections: [
      { key: 'general', titleKey: 'webSearch.title', titleFallback: 'Web Search', keywords: ['web search', 'searxng', 'browse', 'internet', 'council tool'] },
    ],
    component: INLINE_SENTINEL,
  },
  {
    id: 'embeddings',
    shortName: 'Embeddings',
    tabName: 'Embeddings',
    tabDescription: 'Configure embedding models and vector storage',
    tabIcon: Database,
    keywords: ['embeddings', 'vectors', 'semantic', 'search', 'similarity', 'database', 'memory'],
    sections: [
      { key: 'general', titleKey: 'embeddings.title', titleFallback: 'Embeddings', keywords: ['embeddings', 'vectors', 'embedding model', 'dimensions', 'semantic', 'world book vectorization', 'retrieval', 'provider'] },
    ],
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
    sections: [
      { key: 'general', titleKey: 'advanced.title', titleFallback: 'Advanced', keywords: ['advanced', 'image optimization', 'long term memory', 'chunking', 'retrieval', 'query', 'formatting', 'similarity', 'top k', 'context filters', 'reasoning'] },
    ],
    component: INLINE_SENTINEL,
  },
  {
    id: 'lumihub',
    shortName: 'LumiHub',
    tabName: 'LumiHub',
    tabDescription: 'LumiHub cloud sync and sharing settings',
    tabIcon: Globe,
    keywords: ['lumihub', 'cloud', 'sync', 'sharing', 'online', 'hub'],
    sections: [
      { key: 'general', titleKey: 'lumihub.title', titleFallback: 'LumiHub', keywords: ['lumihub', 'cloud', 'sync', 'manifest', 'sharing', 'online'] },
    ],
    component: INLINE_SENTINEL,
  },
  {
    id: 'dataPortability',
    shortName: 'Data',
    tabName: 'Data Portability',
    tabDescription: 'Export your data or import a previously exported archive',
    tabIcon: PackageOpen,
    keywords: ['data', 'portability', 'export', 'import', 'backup', 'restore', 'archive', 'lvbak', 'migrate'],
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
    id: 'ssoProviders',
    shortName: 'SSO',
    tabName: 'Single Sign-On',
    tabDescription: 'Configure owner-managed OpenID Connect sign-in providers',
    tabIcon: KeyRound,
    keywords: ['sso', 'single sign-on', 'openid', 'oidc', 'oauth', 'authelia', 'authentik', 'keycloak', 'identity provider'],
    role: 'owner',
    sections: [
      { key: 'general', titleKey: 'ssoProviders.title', titleFallback: 'Single Sign-On', keywords: ['sso', 'oidc', 'openid connect', 'identity provider', 'client id', 'client secret', 'issuer', 'redirect uri'] },
    ],
    component: INLINE_SENTINEL,
  },
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

/**
 * Stable DOM anchor id for a settings section. Used both by the registry-driven
 * search (to know where to scroll) and by the `<h3>` heading `id` in SettingsModal,
 * so the two never drift apart.
 */
export function sectionAnchorId(tabId: string, sectionKey: string): string {
  return `setsec-${tabId}-${sectionKey}`
}

/** A single searchable result in the in-modal settings search. */
export interface SettingsSearchEntry {
  /** Stable result id (`${tabId}:${sectionKey}` or `${tabId}` for tab-level). */
  id: string
  /** Tab to open when selected. */
  tabId: string
  /** Group label (resolved tab short name). */
  group: string
  /** Icon shown next to the result. */
  icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>
  /** DOM anchor to scroll to, or null to scroll to the top of the tab. */
  anchorId: string | null
  /** Result label (resolved section/tab title). */
  title: string
  /** Combined keywords used for matching. */
  keywords: string[]
}

/**
 * Build the flattened, role-aware search index for the in-modal settings search.
 * Tabs with declared `sections` contribute one entry per section (each scroll-anchored);
 * tabs without sections contribute a single tab-level entry that scrolls to the top.
 * Resolves i18n at call time — callers should memoize on role + active language.
 */
export function getSettingsSearchIndex(userRole?: string): SettingsSearchEntry[] {
  const out: SettingsSearchEntry[] = []
  for (const tab of getVisibleSettingsTabs(userRole)) {
    const group = translateSettingsField(tab.id, 'shortName', tab.shortName)
    if (tab.sections?.length) {
      for (const sec of tab.sections) {
        out.push({
          id: `${tab.id}:${sec.key}`,
          tabId: tab.id,
          group,
          icon: tab.tabIcon,
          anchorId: sectionAnchorId(tab.id, sec.key),
          title: translateSettingsSectionTitle(sec.titleKey, sec.titleFallback),
          keywords: Array.from(new Set([...tab.keywords, ...sec.keywords])),
        })
      }
    } else {
      out.push({
        id: tab.id,
        tabId: tab.id,
        group,
        icon: tab.tabIcon,
        anchorId: null,
        title: translateSettingsField(tab.id, 'tabName', tab.tabName),
        keywords: tab.keywords,
      })
    }
  }
  return out
}

/** Generate Settings commands from the registry for the command palette. */
export function settingsRegistryToCommands(entries: SettingsTabEntry[]): Command[] {
  return entries.map((entry) => ({
    id: `settings-${entry.id}`,
    label: entry.tabName,
    description: entry.tabDescription,
    icon: entry.tabIcon,
    keywords: entry.keywords,
    group: 'settings',
    scope: entry.scope,
    run: () => useStore.getState().openSettings(entry.id),
  }))
}
