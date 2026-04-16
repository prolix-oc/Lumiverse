import type { ComponentType, ReactNode } from 'react'
import {
  User, Wand2, GitFork, Link2, Package, Zap,
  Users, Drama, PenTool, MessageCircle, FileText, Brain, ScrollText,
  MessageSquareReply, Image, Palette, Puzzle, Terminal,
  GitBranch, Globe, Wallpaper, Replace, Library, Sparkles, Database,
} from 'lucide-react'
import { IconUsersGroup } from '@tabler/icons-react'
import { useStore } from '@/store'
import { wsClient } from '@/ws/client'
import type { Command, CommandScope } from '@/lib/commands'
import type { DrawerTabState, ExtensionCommandState } from '@/store/slices/spindle-placement'
import CharacterProfile from '@/components/panels/CharacterProfile'
import CharacterBrowser from '@/components/panels/CharacterBrowser'
import PersonaManager from '@/components/panels/PersonaManager'
import ConnectionManager from '@/components/panels/ConnectionManager'
import ImageGenConnectionManager from '@/components/panels/image-gen-connections/ImageGenConnectionManager'
import TTSConnectionManager from '@/components/panels/tts-connections/TTSConnectionManager'
import PresetManager from '@/components/panels/PresetManager'
import LoomBuilder from '@/components/panels/LoomBuilder'
import DreamWeaverPanel from '@/components/panels/DreamWeaverPanel'
import SummaryEditor from '@/components/panels/SummaryEditor'
import ThemePanel from '@/components/panels/ThemePanel'
import WorldBookPanel from '@/components/panels/world-book/WorldBookPanel'
import SpindlePanel from '@/components/panels/SpindlePanel'
import PackBrowser from '@/components/panels/pack-browser/PackBrowser'
import ContentWorkshop from '@/components/panels/creator-workshop/ContentWorkshop'
import CouncilManager from '@/components/panels/CouncilManager'
import CouncilFeedback from '@/components/panels/CouncilFeedback'
import WorldInfoFeedback from '@/components/panels/WorldInfoFeedback'
import OOCPanel from '@/components/panels/OOCPanel'
import PromptPanel from '@/components/panels/PromptPanel'
import ImageGenPanel from '@/components/panels/ImageGenPanel'
import WallpaperPanel from '@/components/panels/WallpaperPanel'
import BranchTreePanel from '@/components/panels/BranchTreePanel'
import RegexPanel from '@/components/panels/RegexPanel'
import MemoryCortexPanel from '@/components/panels/memory-cortex/MemoryCortexPanel'
import DatabankPanel from '@/components/panels/databank/DatabankPanel'

export interface DrawerTabEntry {
  id: string
  /** Short label shown beneath the icon in the sidebar */
  shortName: string
  /** Full title shown in the command palette listing */
  tabName: string
  /** Description shown in the command palette */
  tabDescription: string
  /** Icon component for sidebar and command palette */
  tabIcon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>
  /** Title shown in the panel header navbar. Falls back to tabName if omitted. */
  tabHeaderTitle?: string
  /** Keywords for command palette fuzzy search */
  keywords: string[]
  /** Optional scope restriction for command palette filtering */
  scope?: CommandScope
  /** React component factory to render the panel content */
  component: () => ReactNode
}

export const DRAWER_TABS: DrawerTabEntry[] = [
  {
    id: 'profile',
    shortName: 'Profile',
    tabName: 'Profile',
    tabDescription: 'View and edit the active character',
    tabIcon: User,
    keywords: ['character', 'avatar', 'info', 'edit', 'card', 'description', 'bio', 'greeting', 'first message'],
    component: () => <CharacterProfile />,
  },
  {
    id: 'presets',
    shortName: 'Presets',
    tabName: 'Reasoning',
    tabDescription: 'Manage generation presets and parameters',
    tabIcon: Wand2,
    tabHeaderTitle: 'Reasoning',
    keywords: ['presets', 'parameters', 'temperature', 'sampler', 'generation', 'reasoning', 'top_p', 'settings', 'max tokens', 'penalty', 'frequency', 'prompt order'],
    component: () => <PresetManager />,
  },
  {
    id: 'loom',
    shortName: 'Loom',
    tabName: 'Loom',
    tabDescription: 'Configure narrative structure and story beats',
    tabIcon: GitFork,
    keywords: ['narrative', 'story', 'lore', 'structure', 'beats', 'loom', 'pacing', 'plot', 'sovereign hand', 'director'],
    component: () => <LoomBuilder compact />,
  },
  {
    id: 'dream-weaver',
    shortName: 'Dream',
    tabName: 'Dream Weaver',
    tabDescription: 'Create characters from your imagination',
    tabIcon: Sparkles,
    keywords: ['dream', 'weave', 'create'],
    component: () => <DreamWeaverPanel />,
  },
  {
    id: 'connections',
    shortName: 'Connect',
    tabName: 'Connections',
    tabDescription: 'Manage API connections and providers',
    tabIcon: Link2,
    tabHeaderTitle: 'Connections',
    keywords: ['api', 'provider', 'key', 'openai', 'anthropic', 'model', 'endpoint', 'google', 'vertex', 'claude', 'gemini', 'openrouter', 'deepseek', 'url', 'secret'],
    component: () => (
      <>
        <ConnectionManager />
        <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--lumiverse-border)' }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: 'var(--lumiverse-text-secondary)' }}>Image Generation</h3>
          <ImageGenConnectionManager />
        </div>
        <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--lumiverse-border)' }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: 'var(--lumiverse-text-secondary)' }}>Text-to-Speech</h3>
          <TTSConnectionManager />
        </div>
      </>
    ),
  },
  {
    id: 'browser',
    shortName: 'Browser',
    tabName: 'Pack Browser',
    tabDescription: 'Browse and manage content packs',
    tabIcon: Package,
    tabHeaderTitle: 'Browser',
    keywords: ['packs', 'content', 'download', 'browse', 'browser', 'install', 'marketplace', 'library', 'search'],
    component: () => <PackBrowser />,
  },
  {
    id: 'characters',
    shortName: 'Chars',
    tabName: 'Characters',
    tabDescription: 'Browse and manage your character cards',
    tabIcon: Users,
    tabHeaderTitle: 'Characters',
    keywords: ['character', 'list', 'import', 'card', 'browse', 'export', 'png', 'charx', 'gallery', 'switch', 'select'],
    component: () => <CharacterBrowser />,
  },
  {
    id: 'personas',
    shortName: 'Personas',
    tabName: 'Personas',
    tabDescription: 'Manage your user personas',
    tabIcon: Drama,
    keywords: ['persona', 'identity', 'user', 'avatar', 'name', 'sender', 'you', 'addons'],
    component: () => <PersonaManager />,
  },
  {
    id: 'lorebook',
    shortName: 'Lore',
    tabName: 'Lorebook',
    tabDescription: 'Edit world book and lorebook entries',
    tabIcon: Library,
    tabHeaderTitle: 'Lorebook',
    keywords: ['lorebook', 'world', 'lore', 'book', 'entries', 'worldbook', 'world info', 'wi', 'keywords', 'triggers', 'knowledge'],
    component: () => <WorldBookPanel />,
  },
  {
    id: 'cortex',
    shortName: 'Memory',
    tabName: 'Memory Cortex',
    tabDescription: 'View and manage memory cortex entries',
    tabIcon: Brain,
    tabHeaderTitle: 'Memory',
    keywords: ['memory', 'cortex', 'embeddings', 'recall', 'brain', 'entities', 'relationships', 'salience', 'vector', 'long term', 'ltcm', 'facts'],
    component: () => <MemoryCortexPanel />,
  },
  {
    id: 'databank',
    shortName: 'Data',
    tabName: 'Databank',
    tabDescription: 'Upload and manage reference documents for AI context',
    tabIcon: Database,
    tabHeaderTitle: 'Databank',
    keywords: ['databank', 'knowledge', 'documents', 'upload', 'files', 'bank', 'reference', 'data', 'rag'],
    component: () => <DatabankPanel />,
  },
  {
    id: 'create',
    shortName: 'Create',
    tabName: 'Creator Workshop',
    tabDescription: 'Create and edit Lumia items and Loom presets',
    tabIcon: PenTool,
    tabHeaderTitle: 'Create',
    keywords: ['create', 'workshop', 'editor', 'build', 'new', 'lumia', 'loom', 'author', 'write', 'draft', 'custom'],
    component: () => <ContentWorkshop />,
  },
  {
    id: 'ooc',
    shortName: 'OOC',
    tabName: 'OOC',
    tabDescription: 'Out-of-character comment display settings',
    tabIcon: MessageCircle,
    keywords: ['ooc', 'out of character', 'comments', 'irc', 'social', 'chat', 'meta', 'parentheses', 'brackets'],
    component: () => <OOCPanel />,
  },
  {
    id: 'prompt',
    shortName: 'Prompt',
    tabName: 'Prompt Inspector',
    tabDescription: 'View the assembled prompt and token breakdown',
    tabIcon: FileText,
    tabHeaderTitle: 'Prompt',
    keywords: ['prompt', 'context', 'tokens', 'breakdown', 'inspect', 'debug', 'assembly', 'dry run', 'preview', 'system', 'blocks'],
    component: () => <PromptPanel />,
  },
  {
    id: 'council',
    shortName: 'Council',
    tabName: 'Council',
    tabDescription: 'Configure the Lumia Council and tool functions',
    tabIcon: IconUsersGroup,
    keywords: ['council', 'tools', 'agents', 'lumia', 'functions', 'tool use', 'sidecar', 'function calling'],
    component: () => <CouncilManager />,
  },
  {
    id: 'summary',
    shortName: 'Summary',
    tabName: 'Summary',
    tabDescription: 'Configure context summarization and truncation',
    tabIcon: ScrollText,
    keywords: ['summary', 'context', 'truncation', 'compress', 'summarize', 'shorten', 'overflow', 'window', 'limit'],
    component: () => <SummaryEditor />,
  },
  {
    id: 'feedback',
    shortName: 'Feedback',
    tabName: 'Council Feedback',
    tabDescription: 'View the latest council execution results',
    tabIcon: MessageSquareReply,
    tabHeaderTitle: 'Feedback',
    keywords: ['feedback', 'council', 'results', 'tools', 'output', 'debug', 'log', 'response', 'execution', 'trace'],
    component: () => <CouncilFeedback />,
  },
  {
    id: 'worldinfo',
    shortName: 'WI',
    tabName: 'World Info',
    tabDescription: 'View currently activated world info entries',
    tabIcon: Globe,
    tabHeaderTitle: 'World Info',
    keywords: ['world info', 'activation', 'lorebook', 'active', 'entries', 'triggered', 'wi', 'matched', 'fired'],
    component: () => <WorldInfoFeedback />,
  },
  {
    id: 'imagegen',
    shortName: 'ImgGen',
    tabName: 'Image Generation',
    tabDescription: 'Configure and control AI scene generation',
    tabIcon: Image,
    tabHeaderTitle: 'Image Gen',
    keywords: ['image', 'generation', 'scene', 'art', 'picture', 'ai', 'background', 'novelai', 'nai', 'dalle', 'illustration'],
    component: () => <ImageGenPanel />,
  },
  {
    id: 'wallpaper',
    shortName: 'Wallppr',
    tabName: 'Wallpaper',
    tabDescription: 'Set global or per-chat background wallpapers',
    tabIcon: Wallpaper,
    keywords: ['wallpaper', 'background', 'backdrop', 'image', 'video', 'animated', 'mp4', 'webm', 'gif', 'scenery', 'chat background'],
    component: () => <WallpaperPanel />,
  },
  {
    id: 'regex',
    shortName: 'Regex',
    tabName: 'Regex Scripts',
    tabDescription: 'Create and manage regex find/replace scripts',
    tabIcon: Replace,
    tabHeaderTitle: 'Regex',
    keywords: ['regex', 'find', 'replace', 'script', 'transform', 'filter', 'pattern', 'substitution', 'text', 'output', 'display', 'rewrite', 'format'],
    component: () => <RegexPanel />,
  },
  {
    id: 'branches',
    shortName: 'Branch',
    tabName: 'Branch Tree',
    tabDescription: 'View and navigate the chat branch history',
    tabIcon: GitBranch,
    tabHeaderTitle: 'Branches',
    keywords: ['branch', 'fork', 'history', 'tree', 'navigate', 'alternate', 'swipe', 'undo', 'timeline', 'rewind', 'path'],
    component: () => <BranchTreePanel />,
  },
  {
    id: 'theme',
    shortName: 'Theme',
    tabName: 'Theme',
    tabDescription: 'Customize colors, accent, and visual style',
    tabIcon: Palette,
    keywords: ['theme', 'colors', 'accent', 'appearance', 'dark', 'light', 'glass', 'radius', 'font', 'css', 'style', 'customize', 'ui', 'mode'],
    component: () => <ThemePanel />,
  },
  {
    id: 'spindle',
    shortName: 'Extend',
    tabName: 'Extensions',
    tabDescription: 'Manage Spindle extensions',
    tabIcon: Puzzle,
    tabHeaderTitle: 'Extensions',
    keywords: ['extensions', 'spindle', 'plugins', 'addons', 'install', 'manage', 'enable', 'disable', 'uninstall', 'github'],
    component: () => <SpindlePanel />,
  },
]

/** Adapt extension DrawerTabState entries into DrawerTabEntry format. */
export function adaptExtensionTabs(tabs: DrawerTabState[]): DrawerTabEntry[] {
  return tabs.map((dt) => ({
    id: dt.id,
    shortName: dt.shortName ?? (dt.title.length > 8 ? dt.title.slice(0, 7) + '\u2026' : dt.title),
    tabName: dt.title,
    tabDescription: dt.description ?? `Open ${dt.title} extension tab`,
    tabIcon: Puzzle,
    tabHeaderTitle: dt.headerTitle,
    keywords: ['extension', 'spindle', dt.extensionId, ...(dt.keywords ?? [])],
    component: () => null,
  }))
}

/** Generate Panel commands from the registry for the command palette. */
export function registryToCommands(entries: DrawerTabEntry[]): Command[] {
  return entries.map((entry) => ({
    id: `panel-${entry.id}`,
    label: entry.tabName,
    description: entry.tabDescription,
    icon: entry.tabIcon,
    keywords: entry.keywords,
    group: 'Panels' as const,
    scope: entry.scope,
    run: () => useStore.getState().openDrawer(entry.id),
  }))
}

/** Convert extension drawer tabs into Command objects for the palette. */
export function extensionTabsToCommands(tabs: DrawerTabState[]): Command[] {
  return tabs.map((tab) => ({
    id: `ext-tab-${tab.id}`,
    label: tab.title,
    description: tab.description ?? `Open ${tab.title} extension tab`,
    icon: Puzzle,
    keywords: ['extension', 'spindle', tab.extensionId, ...(tab.keywords ?? [])],
    group: 'Extensions' as const,
    run: () => useStore.getState().openDrawer(tab.id),
  }))
}

/** Convert extension-registered commands into Command objects for the palette. */
export function extensionCommandsToCommands(entries: ExtensionCommandState[]): Command[] {
  const commands: Command[] = []
  for (const entry of entries) {
    for (const cmd of entry.commands) {
      commands.push({
        id: `ext-cmd-${entry.extensionId}-${cmd.id}`,
        label: cmd.label,
        description: cmd.description,
        icon: Terminal,
        keywords: ['extension', entry.extensionName, ...(cmd.keywords ?? [])],
        group: 'Extensions' as const,
        scope: cmd.scope as CommandScope | undefined,
        run: () => {
          const state = useStore.getState()
          wsClient.send({
            type: 'SPINDLE_COMMAND_INVOKE',
            extensionId: entry.extensionId,
            commandId: cmd.id,
            context: {
              route: window.location.pathname,
              chatId: state.activeChatId ?? undefined,
              characterId: state.activeCharacterId ?? undefined,
              isGroupChat: state.isGroupChat ?? false,
            },
          })
        },
      })
    }
  }
  return commands
}
