import { memo, type ReactNode } from 'react'
import { User, UserCheck, Crown, Link2 } from 'lucide-react'
import { personasApi } from '@/api/personas'
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
}

const PersonaRow = memo(function PersonaRow({
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
        styles.row,
        isSelected && styles.rowSelected,
        isActive && styles.rowActive
      )}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(isSelected ? null : persona.id)}
      onDoubleClick={() => onDoubleClick(persona.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect(isSelected ? null : persona.id)
      }}
    >
      <div className={styles.avatar}>
        <LazyImage
          src={personasApi.avatarUrl(persona.id)}
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
  )
})

export default function PersonaCardList({
  personas,
  selectedId,
  activeId,
  onSelect,
  onDoubleClick,
  renderEditor,
}: PersonaCardListProps) {
  if (personas.length === 0) {
    return <div className={styles.empty}>No personas found.</div>
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
          />
          {renderEditor && selectedId === persona.id && renderEditor(persona.id)}
        </div>
      ))}
    </div>
  )
}
