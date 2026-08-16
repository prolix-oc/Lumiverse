import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Star, Pencil } from 'lucide-react'
import { getCharacterAvatarThumbUrl, getCharacterAvatarLargeUrl } from '@/lib/avatarUrls'
import { getTagColor } from '@/lib/tagColors'
import LazyImage from '@/components/shared/LazyImage'
import { useSpindleComponentOverride } from '@/lib/spindle/use-spindle-component-override'
import type { Character, CharacterSummary } from '@/types/api'
import styles from './CharacterCard.module.css'
import clsx from 'clsx'

interface CharacterCardProps {
  character: Character | CharacterSummary
  isFavorite: boolean
  isSelected?: boolean
  batchMode?: boolean
  compact?: boolean
  /** Use the large image tier (~700px) instead of the small tier (~300px) */
  useLargeTier?: boolean
  onOpen: (character: Character | CharacterSummary) => void
  onEdit?: (id: string) => void
  onToggleFavorite: (id: string) => void
  onToggleBatch?: (id: string) => void
}

function CharacterCardNative({
  character,
  isFavorite,
  isSelected,
  batchMode,
  compact,
  useLargeTier,
  onOpen,
  onEdit,
  onToggleFavorite,
  onToggleBatch,
}: CharacterCardProps) {
  const { t } = useTranslation('panels')
  const avatarUrl = (useLargeTier ? getCharacterAvatarLargeUrl(character) : getCharacterAvatarThumbUrl(character)) ?? ''
  const tags = character.tags?.slice(0, 3) || []
  const extraTagCount = (character.tags?.length || 0) - 3

  const handleClick = () => {
    if (batchMode && onToggleBatch) {
      onToggleBatch(character.id)
    } else {
      onOpen(character)
    }
  }

  return (
    <div
      className={clsx(styles.card, compact && styles.compact, isSelected && styles.selected)}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && handleClick()}
    >
      <div className={styles.imageWrap}>
        <LazyImage
          src={avatarUrl}
          alt={character.name}
          className={styles.coverImg}
          fallback={
            <div className={styles.avatarFallback}>
              {character.name[0]?.toUpperCase()}
            </div>
          }
        />
        {batchMode && (
          <div className={styles.checkbox}>
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => onToggleBatch?.(character.id)}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
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
            <Pencil size={13} />
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
        <span data-spindle-mount="character_browser_card_actions" data-spindle-scope={`character-card:${character.id}:actions`} style={{ display: 'contents' }} />
      </div>
      <div className={styles.info}>
        <span className={styles.name}>{character.name}</span>
        {!compact && character.creator && (
          <span className={styles.creator}>{character.creator}</span>
        )}
        {!compact && tags.length > 0 && (
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
            {extraTagCount > 0 && (
              <span className={styles.tagOverflow}>+{extraTagCount}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function CharacterCard(props: CharacterCardProps) {
  return useSpindleComponentOverride('CharacterCard', CharacterCardNative, props)
}

export default memo(CharacterCard)
