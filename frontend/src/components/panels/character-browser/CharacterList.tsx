import { useRef, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useScrollGate } from '@/hooks/useScrollGate'
import { getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import { prefetchImages } from '@/lib/imageDecodeCache'
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
  useScrollGate(parentRef)

  const virtualizer = useVirtualizer({
    count: characters.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    paddingStart: 10,
    paddingEnd: 10,
  })

  // Prefetch avatar images for rows near the visible viewport so they're
  // already decoded when the virtualizer scrolls them into view.
  const PREFETCH_ROWS = 10
  const virtualItems = virtualizer.getVirtualItems()
  const visStart = virtualItems.length > 0 ? virtualItems[0].index : -1
  const visEnd = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : -1
  
  useEffect(() => {
    if (visStart < 0 || characters.length === 0) return
    const startIdx = Math.max(0, visStart - PREFETCH_ROWS)
    const endIdx = Math.min(characters.length, visEnd + PREFETCH_ROWS + 1)
    const urls: string[] = []
    
    for (let i = startIdx; i < endIdx; i++) {
      const char = characters[i]
      if (!char) continue
      // CharacterList uses ThumbUrl via CharacterRow
      const url = getCharacterAvatarThumbUrl(char)
      if (url) urls.push(url)
    }
    
    if (urls.length > 0) prefetchImages(urls)
  }, [visStart, visEnd, characters])

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
