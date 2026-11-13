import { memo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { User, UserCheck, Crown, Link2, Check } from 'lucide-react'
import { getPersonaAvatarThumbUrl } from '@/lib/avatarUrls'
import LazyImage from '@/components/shared/LazyImage'
import type { Persona } from '@/types/api'
import styles from './PersonaCardList.module.css'
import clsx from 'clsx'

interface PersonaCardListProps {
  personas: Persona[]
  selectedId: string | null
  activeId: string | null
  onSelect: (id: string | null) => void
  onDoubleClick: (id: string) => void
  renderEditor?: (personaId: string) => ReactNode
  batchMode?: boolean
  batchSelectedIds?: Set<string>
  onToggleBatch?: (id: string) => void
}

const PersonaRow = memo(function PersonaRow({
  persona,
  isSelected,
  isActive,
  onSelect,
  onDoubleClick,
  batchMode,
  isBatchSelected,
  onToggleBatch,
}: {
  persona: Persona
  isSelected: boolean
  isActive: boolean
  onSelect: (id: string | null) => void
  onDoubleClick: (id: string) => void
  batchMode?: boolean
  isBatchSelected?: boolean
  onToggleBatch?: (id: string) => void
}) {
  const { t } = useTranslation('panels', { keyPrefix: 'personaManager.badges' })
  return (
    <div
      className={clsx(
        styles.row,
        (isSelected || isBatchSelected) && styles.rowSelected,
        isActive && styles.rowActive
      )}
      role="button"
      tabIndex={0}
      aria-pressed={batchMode ? !!isBatchSelected : isSelected}
      onClick={() => batchMode ? onToggleBatch?.(persona.id) : onSelect(isSelected ? null : persona.id)}
      onDoubleClick={() => { if (!batchMode) onDoubleClick(persona.id) }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || (batchMode && e.key === ' ')) {
          e.preventDefault()
          if (batchMode) onToggleBatch?.(persona.id)
          else onSelect(isSelected ? null : persona.id)
        }
      }}
    >
      {batchMode && (
        <span className={clsx(styles.batchCheck, isBatchSelected && styles.batchCheckSelected)}>
          {isBatchSelected && <Check size={11} />}
        </span>
      )}
      <div className={styles.avatar}>
        <LazyImage
          src={getPersonaAvatarThumbUrl(persona) || ''}
          alt={persona.name}
          className={styles.avatarImg}
          fallback={
            <div className={styles.avatarFallback}>
              <User size={16} />
            </div>
          }
        />
      </div>
      <div className={styles.info}>
        <span className={styles.name}>{persona.name}</span>
        {persona.title && <span className={styles.title}>{persona.title}</span>}
        {persona.description && (
          <span className={styles.desc}>{persona.description}</span>
        )}
      </div>
      <div className={styles.badges}>
        {isActive && (
          <span className={clsx(styles.badge, styles.badgeActive)} title={t('active')}>
            <UserCheck size={10} />
          </span>
        )}
        {persona.is_default && (
          <span className={clsx(styles.badge, styles.badgeDefault)} title={t('default')}>
            <Crown size={10} />
          </span>
        )}
        {persona.attached_world_book_id && (
          <span className={clsx(styles.badge, styles.badgeConnected)} title={t('connected')}>
            <Link2 size={10} />
          </span>
        )}
      </div>
    </div>
  )
})

export default function PersonaCardList({
  personas,
  selectedId,
  activeId,
  onSelect,
  onDoubleClick,
  renderEditor,
  batchMode = false,
  batchSelectedIds = new Set(),
  onToggleBatch,
}: PersonaCardListProps) {
  const { t } = useTranslation('panels', { keyPrefix: 'personaManager' })
  if (personas.length === 0) {
    return <div className={styles.empty}>{t('noPersonasFound')}</div>
  }

  return (
    <div className={styles.list}>
      {personas.map((persona) => (
        <div key={persona.id}>
          <PersonaRow
            persona={persona}
            isSelected={selectedId === persona.id}
            isActive={activeId === persona.id}
            onSelect={onSelect}
            onDoubleClick={onDoubleClick}
            batchMode={batchMode}
            isBatchSelected={batchSelectedIds.has(persona.id)}
            onToggleBatch={onToggleBatch}
          />
          {!batchMode && renderEditor && selectedId === persona.id && renderEditor(persona.id)}
        </div>
      ))}
    </div>
  )
}
