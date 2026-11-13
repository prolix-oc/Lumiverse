import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import { useConnectionLibrary } from '@/hooks/useConnectionLibrary'
import { rememberConnection, useConnectionRecents } from '@/hooks/useConnectionRecents'
import { filterConnections } from '@/lib/connectionSearch'
import type { ConnectionProfile } from '@/types/api'
import FolderSection from './FolderSection'
import SearchField from './SearchField'
import ProviderIcon from './ProviderIcon'
import styles from './ConnectionQuickPicker.module.css'

/** The chat input's inline picker uses the same folders as the full manager. */
export default function ConnectionQuickPicker({ onSelect }: { onSelect: (id: string) => void }) {
  const profiles = useStore(state => state.profiles)
  const activeId = useStore(state => state.activeProfileId)
  const library = useConnectionLibrary('llm')
  const recentIds = useConnectionRecents('llm')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const { t } = useTranslation('panels')
  const { t: ts } = useTranslation('shared')
  const { t: tc } = useTranslation('common')
  const uncategorized = ts('searchableSelect.uncategorized')
  const visible = filterConnections(profiles, query, id => library.folderName(id) || uncategorized)
  const byId = new Map(visible.map(profile => [profile.id, profile]))
  const recent = recentIds.map(id => byId.get(id)).filter((profile): profile is ConnectionProfile => !!profile)
  const renderProfile = (profile: ConnectionProfile) => <button key={profile.id} type="button"
    className={`${styles.row} ${activeId === profile.id ? styles.active : ''}`}
    aria-pressed={activeId === profile.id} onClick={() => { onSelect(profile.id); rememberConnection('llm', profile.id) }}>
    <ProviderIcon kind="llm" provider={profile.provider} size={22} />
    <span className={styles.name}><span>{profile.name}</span>
      <span className={styles.model}>{profile.provider}{profile.model ? ` / ${profile.model}` : ''}</span>
    </span>
  </button>
  return <div className={styles.picker}>
    <SearchField value={query} onChange={setQuery} placeholder={t('connections.search')} clearLabel={tc('actions.clear')} />
    {recent.length > 0 && <FolderSection recent label={ts('searchableSelect.recentlyUsed')} count={recent.length}>
      {recent.map(renderProfile)}
    </FolderSection>}
    {library.folders.map(folder => {
      const members = visible.filter(profile => library.folderId(profile.id) === folder.id)
      if (!members.length) return null
      return <FolderSection key={folder.id} label={folder.name || uncategorized} count={members.length}
        collapsed={!query.trim() && !!collapsed[folder.id]}
        onToggle={() => setCollapsed(value => ({ ...value, [folder.id]: !value[folder.id] }))}>
        {members.map(renderProfile)}
      </FolderSection>
    })}
    {visible.length === 0 && <div role="status" className={styles.empty}>{t('connections.noMatches')}</div>}
  </div>
}
