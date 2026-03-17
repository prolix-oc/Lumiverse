import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import CharacterRow from './CharacterRow'
import type { Character, CharacterSummary } from '@/types/api'
import styles from './CharacterList.module.css'

interface CharacterListProps {
  characters: (Character | CharacterSummary)[]
  favorites: string[]
  batchMode: boolean
  batchSelected: string[]
  onOpen: (character: Character | CharacterSummary) => void
  onEdit: (id: string) => void
  onToggleFavorite: (id: string) => void
  onToggleBatch: (id: string) => void
}

const ROW_HEIGHT = 74

export default function CharacterList({
  characters,
  favorites,
  batchMode,
  batchSelected,
  onOpen,
  onEdit,
  onToggleFavorite,
  onToggleBatch,
}: CharacterListProps) {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: characters.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  })

  if (characters.length === 0) return null

  return (
    <div ref={parentRef} className={styles.scrollContainer}>
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const character = characters[virtualRow.index]
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <CharacterRow
                character={character}
                isFavorite={favorites.includes(character.id)}
                isSelected={batchSelected.includes(character.id)}
                batchMode={batchMode}
                onOpen={onOpen}
                onEdit={onEdit}
                onToggleFavorite={onToggleFavorite}
                onToggleBatch={onToggleBatch}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
