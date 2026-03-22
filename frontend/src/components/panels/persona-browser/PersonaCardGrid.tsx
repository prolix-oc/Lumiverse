import { Fragment, memo, useRef, useState, useEffect, useCallback, type ReactNode } from 'react'
import { User, UserCheck, Crown, Link2 } from 'lucide-react'
import { personasApi } from '@/api/personas'
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
}

const PersonaCard = memo(function PersonaCard({
  persona,
  isSelected,
  isActive,
  onSelect,
  onDoubleClick,
}: {
  persona: Persona
  isSelected: boolean
  isActive: boolean
  onSelect: (id: string | null) => void
  onDoubleClick: (id: string) => void
}) {
  return (
    <div
      className={clsx(
        styles.card,
        isSelected && styles.cardSelected,
        isActive && styles.cardActive
      )}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(isSelected ? null : persona.id)}
      onDoubleClick={() => onDoubleClick(persona.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect(isSelected ? null : persona.id)
      }}
    >
      <div className={styles.avatarWrap}>
        <LazyImage
          src={personasApi.avatarUrl(persona.id)}
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
            <span className={clsx(styles.badge, styles.badgeActive)} title="Active">
              <UserCheck size={10} />
            </span>
          )}
          {persona.is_default && (
            <span className={clsx(styles.badge, styles.badgeDefault)} title="Default">
              <Crown size={10} />
            </span>
          )}
          {persona.attached_world_book_id && (
            <span className={clsx(styles.badge, styles.badgeConnected)} title="Connected">
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
}: PersonaCardGridProps) {
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
    return <div className={styles.empty}>No personas found.</div>
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
          />
          {renderEditor && selectedId && i === editorAfterIdx && (
            <div className={styles.inlineEditor}>
              {renderEditor(selectedId)}
            </div>
          )}
        </Fragment>
      ))}
    </div>
  )
}
