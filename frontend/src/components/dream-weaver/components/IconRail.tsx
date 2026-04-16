import {
  PanelLeftOpen, PanelLeftClose, Heart,
  User, Eye, FileText, Brain, MapPin, MessageCircle, Mic, Terminal,
  Globe, Users, Layers, MessageSquare,
  Code,
} from 'lucide-react'
import type { TabId, SectionStatus } from '../hooks/useDreamWeaverStudio'
import styles from './IconRail.module.css'

interface RailIcon {
  id: string
  icon: React.ReactNode
  label: string
  status: SectionStatus
}

interface IconRailProps {
  activeTab: TabId
  expanded: boolean
  onToggle: () => void
  onScrollToSection: (sectionId: string) => void
  onOpenHealth: () => void
  getSectionStatus: (section: string) => SectionStatus
  kind?: 'character' | 'scenario'
}

const SZ = 16

function getTabIcons(
  tab: TabId,
  getStatus: (s: string) => SectionStatus,
  kind?: 'character' | 'scenario',
): RailIcon[] {
  switch (tab) {
    case 'soul':
      return [
        { id: 'name', icon: <User size={SZ} />, label: 'Name', status: getStatus('name') },
        ...(kind !== 'scenario' ? [{ id: 'appearance', icon: <Eye size={SZ} />, label: 'Appearance', status: getStatus('appearance') }] : []),
        { id: 'description', icon: <FileText size={SZ} />, label: 'Description', status: getStatus('description') },
        { id: 'personality', icon: <Brain size={SZ} />, label: 'Personality', status: getStatus('personality') },
        { id: 'scenario', icon: <MapPin size={SZ} />, label: 'Scenario', status: getStatus('scenario') },
        { id: 'first_mes', icon: <MessageCircle size={SZ} />, label: 'First Message', status: getStatus('first_mes') },
        { id: 'voice_guidance', icon: <Mic size={SZ} />, label: 'Voice Guidance', status: getStatus('voice_guidance') },
        { id: 'alternate_fields', icon: <Layers size={SZ} />, label: 'Alternates', status: getStatus('alternate_fields') },
        { id: 'greetings', icon: <MessageSquare size={SZ} />, label: 'Greetings', status: getStatus('greetings') },
        { id: 'system_prompt', icon: <Terminal size={SZ} />, label: 'System Prompt', status: getStatus('system_prompt') },
      ]
    case 'world':
      return [
        { id: 'lorebooks', icon: <Globe size={SZ} />, label: 'World Books', status: getStatus('lorebooks') },
        { id: 'npc_definitions', icon: <Users size={SZ} />, label: 'NPCs', status: getStatus('npc_definitions') },
      ]
    case 'visuals':
      return [
        { id: 'package_health', icon: <Code size={SZ} />, label: 'Portrait', status: getStatus('package_health') },
      ]
  }
}

export function IconRail({
  activeTab, expanded, onToggle, onScrollToSection,
  onOpenHealth, getSectionStatus, kind,
}: IconRailProps) {
  const icons = getTabIcons(activeTab, getSectionStatus, kind)

  return (
    <div className={styles.rail} data-expanded={expanded || undefined}>
      <button className={styles.toggleButton} onClick={onToggle} title={expanded ? 'Collapse' : 'Expand'}>
        {expanded ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
      </button>

      <div className={styles.icons}>
        {icons.map((item) => (
          <button
            key={item.id}
            className={styles.iconButton}
            onClick={() => onScrollToSection(item.id)}
            title={item.label}
          >
            {item.icon}
            <span className={styles.statusDot} data-status={item.status} />
            {expanded && <span className={styles.iconLabel}>{item.label}</span>}
          </button>
        ))}
      </div>

      <div className={styles.divider} />

      <div className={styles.icons}>
        <button className={styles.iconButton} onClick={onOpenHealth} title="Package Health">
          <Heart size={SZ} />
          {expanded && <span className={styles.iconLabel}>Health</span>}
        </button>
      </div>
    </div>
  )
}
