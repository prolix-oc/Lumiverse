import { Fragment, memo, useRef, useState, useEffect, useCallback, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { User, UserCheck, Crown, Link2, Check } from 'lucide-react'
import { getPersonaAvatarThumbUrl } from '@/lib/avatarUrls'
import LazyImage from '@/components/shared/LazyImage'
import type { Persona } from '@/types/api'
import styles from './PersonaCardGrid.module.css'
import clsx from 'clsx'

interface PersonaCardGridProps {
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

const PersonaCard = memo(function PersonaCard({
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
        styles.card,
        (isSelected || isBatchSelected) && styles.cardSelected,
        isActive && styles.cardActive
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
      <div className={styles.avatarWrap}>
        {batchMode && (
          <span className={clsx(styles.batchCheck, isBatchSelected && styles.batchCheckSelected)}>
            {isBatchSelected && <Check size={12} />}
          </span>
        )}
        <LazyImage
          src={getPersonaAvatarThumbUrl(persona) || ''}
          alt={persona.name}
          className={styles.avatarImg}
          fallback={
            <div className={styles.avatarFallback}>
              <User size={28} />
            </div>
          }
        />
        {/* Badge overlays */}
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
      <div className={styles.nameGroup}>
        <span className={styles.name}>{persona.name}</span>
        {persona.title && <span className={styles.title}>{persona.title}</span>}
      </div>
    </div>
  )
})

export default function PersonaCardGrid({
  personas,
  selectedId,
  activeId,
  onSelect,
  onDoubleClick,
  renderEditor,
  batchMode = false,
  batchSelectedIds = new Set(),
  onToggleBatch,
}: PersonaCardGridProps) {
  const { t } = useTranslation('panels', { keyPrefix: 'personaManager' })
  const gridRef = useRef<HTMLDivElement>(null)
  const [colCount, setColCount] = useState(4)

  const measureCols = useCallback(() => {
    const el = gridRef.current
    if (!el) return
    const cols = getComputedStyle(el).gridTemplateColumns.split(' ').length
    setColCount(cols)
  }, [])

  useEffect(() => {
    measureCols()
    const ro = new ResizeObserver(measureCols)
    if (gridRef.current) ro.observe(gridRef.current)
    return () => ro.disconnect()
  }, [measureCols])

  if (personas.length === 0) {
    return <div className={styles.empty}>{t('noPersonasFound')}</div>
  }

  // Figure out which index to insert the editor after: the last card in the
  // same row as the selected card, so remaining cards on the row stay put.
  const selectedIdx = selectedId ? personas.findIndex((p) => p.id === selectedId) : -1
  const editorAfterIdx = selectedIdx >= 0
    ? Math.min(selectedIdx - (selectedIdx % colCount) + colCount - 1, personas.length - 1)
    : -1

  return (
    <div className={styles.grid} ref={gridRef}>
      {personas.map((persona, i) => (
        <Fragment key={persona.id}>
          <PersonaCard
            persona={persona}
            isSelected={selectedId === persona.id}
            isActive={activeId === persona.id}
            onSelect={onSelect}
            onDoubleClick={onDoubleClick}
            batchMode={batchMode}
            isBatchSelected={batchSelectedIds.has(persona.id)}
            onToggleBatch={onToggleBatch}
          />
          {!batchMode && renderEditor && selectedId && i === editorAfterIdx && (
            <div className={styles.inlineEditor}>
              {renderEditor(selectedId)}
            </div>
          )}
        </Fragment>
      ))}
    </div>
  )
}
