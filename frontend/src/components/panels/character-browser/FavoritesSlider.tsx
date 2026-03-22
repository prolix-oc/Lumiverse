import CharacterCard from './CharacterCard'
import type { Character, CharacterSummary } from '@/types/api'
import styles from './FavoritesSlider.module.css'

interface FavoritesSliderProps {
  characters: (Character | CharacterSummary)[]
  favorites: string[]
  onOpen: (character: Character | CharacterSummary) => void
  onToggleFavorite: (id: string) => void
}

export default function FavoritesSlider({
  characters,
  favorites,
  onOpen,
  onToggleFavorite,
}: FavoritesSliderProps) {
  if (characters.length === 0) return null

  return (
    <div className={styles.container}>
      <div className={styles.label}>Favorites</div>
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
    </div>
  )
}
