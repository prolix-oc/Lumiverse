import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Star, Pencil } from 'lucide-react'
import { getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import { getTagColor } from '@/lib/tagColors'
import LazyImage from '@/components/shared/LazyImage'
import type { Character, CharacterSummary } from '@/types/api'
import styles from './CharacterRow.module.css'
import clsx from 'clsx'

interface CharacterRowProps {
  character: Character | CharacterSummary
  isFavorite: boolean
  isSelected?: boolean
  batchMode?: boolean
  onOpen: (character: Character | CharacterSummary) => void
  onEdit?: (id: string) => void
  onToggleFavorite: (id: string) => void
  onToggleBatch?: (id: string) => void
}

export default memo(function CharacterRow({
  character,
  isFavorite,
  isSelected,
  batchMode,
  onOpen,
  onEdit,
  onToggleFavorite,
  onToggleBatch,
}: CharacterRowProps) {
  const { t } = useTranslation('panels')
  const avatarUrl = getCharacterAvatarThumbUrl(character) ?? ''
  const tags = character.tags?.slice(0, 3) || []

  const handleClick = () => {
    if (batchMode && onToggleBatch) {
      onToggleBatch(character.id)
    } else {
      onOpen(character)
    }
  }

  return (
    <div
      className={clsx(styles.row, isSelected && styles.selected)}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && handleClick()}
    >
      {batchMode && (
        <input
          type="checkbox"
          className={styles.checkbox}
          checked={isSelected}
          onChange={() => onToggleBatch?.(character.id)}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      <div className={styles.avatar}>
        <LazyImage
          src={avatarUrl}
          alt={character.name}
          fallback={
            <div className={styles.avatarFallback}>
              {character.name[0]?.toUpperCase()}
            </div>
          }
        />
      </div>
      <div className={styles.info}>
        <span className={styles.name}>{character.name}</span>
        {character.creator && (
          <span className={styles.creator}>{t('characterProfile.byCreator', { creator: character.creator })}</span>
        )}
        {tags.length > 0 && (
          <div className={styles.tags}>
            {tags.map((tag) => {
              const color = getTagColor(tag)
              return (
                <span
                  key={tag}
                  className={styles.tag}
                  style={{ background: color.bg, color: color.text, borderColor: color.border }}
                >
                  {tag}
                </span>
              )
            })}
          </div>
        )}
      </div>
      {!batchMode && onEdit && (
        <button
          type="button"
          className={styles.editBtn}
          onClick={(e) => {
            e.stopPropagation()
            onEdit(character.id)
          }}
          title={t('characterBrowser.editCharacter')}
        >
          <Pencil size={12} />
        </button>
      )}
      {!batchMode && (
        <button
          type="button"
          className={clsx(styles.favBtn, isFavorite && styles.favBtnActive)}
          onClick={(e) => {
            e.stopPropagation()
            onToggleFavorite(character.id)
          }}
          title={isFavorite ? t('characterBrowser.removeFromFavorites') : t('characterBrowser.addToFavorites')}
        >
          <Star size={14} fill={isFavorite ? 'currentColor' : 'none'} />
        </button>
      )}
    </div>
  )
})
