import { useRef, useCallback, useState, useEffect, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useScrollGate } from '@/hooks/useScrollGate'
import CharacterCard from './CharacterCard'
import type { Character, CharacterSummary } from '@/types/api'
import styles from './CharacterGrid.module.css'

interface CharacterGridProps {
  characters: (Character | CharacterSummary)[]
  favorites: string[]
  batchMode: boolean
  batchSelected: string[]
  singleColumn?: boolean
  onOpen: (character: Character | CharacterSummary) => void
  onEdit: (id: string) => void
  onToggleFavorite: (id: string) => void
  onToggleBatch: (id: string) => void
}

const MIN_COL_WIDTH = 200
const GAP = 16
const INFO_HEIGHT = 64 // name + creator + tags padding

export default function CharacterGrid({
  characters,
  favorites,
  batchMode,
  batchSelected,
  singleColumn,
  onOpen,
  onEdit,
  onToggleFavorite,
  onToggleBatch,
}: CharacterGridProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  useScrollGate(parentRef)
  const [columns, setColumns] = useState(singleColumn ? 1 : 2)
  const [containerWidth, setContainerWidth] = useState(400)

  // O(1) lookups instead of O(n) includes() per card
  const favSet = useMemo(() => new Set(favorites), [favorites])
  const batchSet = useMemo(() => new Set(batchSelected), [batchSelected])

  // Observe container width to calculate columns
  useEffect(() => {
    const el = parentRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth
      setContainerWidth(width)
      if (singleColumn) {
        setColumns(1)
      } else {
        setColumns(Math.max(1, Math.floor((width + GAP) / (MIN_COL_WIDTH + GAP))))
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [singleColumn])

  // Compute row height from actual column width: image is 3:4 aspect + info section
  const colWidth = (containerWidth - GAP * (columns - 1) - GAP) / columns
  const rowHeight = Math.round(colWidth * (4 / 3)) + INFO_HEIGHT + GAP

  const rowCount = Math.ceil(characters.length / columns)

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 5,
  })

  const getCharacter = useCallback(
    (rowIndex: number, colIndex: number): Character | CharacterSummary | undefined => {
      const index = rowIndex * columns + colIndex
      return characters[index]
    },
    [characters, columns]
  )

  if (characters.length === 0) return null

  return (
    <div ref={parentRef} className={styles.scrollContainer}>
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.key}
            className={styles.row}
            style={{
              position: 'absolute',
              top: virtualRow.start,
              left: 0,
              right: 0,
              height: virtualRow.size,
              display: 'grid',
              gridTemplateColumns: `repeat(${columns}, 1fr)`,
              gap: `${GAP}px`,
              padding: `0 ${GAP / 2}px ${GAP}px`,
            }}
          >
            {Array.from({ length: columns }).map((_, colIndex) => {
              const character = getCharacter(virtualRow.index, colIndex)
              if (!character) return <div key={colIndex} />
              return (
                <CharacterCard
                  key={character.id}
                  character={character}
                  isFavorite={favSet.has(character.id)}
                  isSelected={batchSet.has(character.id)}
                  batchMode={batchMode}
                  useLargeTier
                  onOpen={onOpen}
                  onEdit={onEdit}
                  onToggleFavorite={onToggleFavorite}
                  onToggleBatch={onToggleBatch}
                />
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
