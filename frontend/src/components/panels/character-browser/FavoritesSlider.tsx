import { ChevronDown, ChevronRight, Star } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import CharacterCard from './CharacterCard'
import LazyImage from '@/components/shared/LazyImage'
import { getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import type { Character, CharacterSummary } from '@/types/api'
import styles from './FavoritesSlider.module.css'

interface FavoritesSliderProps {
  characters: (Character | CharacterSummary)[]
  favorites: string[]
  collapsed: boolean
  onOpen: (character: Character | CharacterSummary) => void
  onToggleFavorite: (id: string) => void
  onToggleCollapse: () => void
}

function AvatarChip({
  character,
  onClick,
}: {
  character: Character | CharacterSummary
  onClick: (character: Character | CharacterSummary) => void
}) {
  const avatarUrl = getCharacterAvatarThumbUrl(character) ?? ''
  return (
    <button
      type="button"
      className={styles.avatarChip}
      onClick={(e) => {
        e.stopPropagation()
        onClick(character)
      }}
      title={character.name}
      aria-label={character.name}
    >
      <LazyImage
        src={avatarUrl}
        alt={character.name}
        className={styles.avatarChipImg}
        fallback={<span className={styles.avatarChipFallback}>{character.name[0]?.toUpperCase()}</span>}
      />
    </button>
  )
}

export default function FavoritesSlider({
  characters,
  favorites,
  collapsed,
  onOpen,
  onToggleFavorite,
  onToggleCollapse,
}: FavoritesSliderProps) {
  const { t } = useTranslation('panels', { keyPrefix: 'characterToolbar' })

  if (characters.length === 0) return null

  return (
    <div className={styles.container}>
      <button
        type="button"
        className={styles.header}
        onClick={onToggleCollapse}
        aria-expanded={!collapsed}
        aria-label={collapsed ? t('expandFavorites') : t('collapseFavorites')}
      >
        <span className={styles.headerStart}>
          <span className={styles.iconBadge}>
            <Star size={12} fill="currentColor" />
          </span>
          <span className={styles.label}>{t('favorites')}</span>
          <span className={styles.countBadge}>{characters.length}</span>
        </span>

        {collapsed && (
          <span className={styles.inlineAvatars}>
            {characters.map((char) => (
              <AvatarChip key={char.id} character={char} onClick={onOpen} />
            ))}
          </span>
        )}

        <span className={styles.chevron}>
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {!collapsed && (
        <div className={styles.slider}>
          {characters.map((char) => (
            <div key={char.id} className={styles.slideItem}>
              <CharacterCard
                character={char}
                isFavorite={favorites.includes(char.id)}
                compact
                onOpen={onOpen}
                onToggleFavorite={onToggleFavorite}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
