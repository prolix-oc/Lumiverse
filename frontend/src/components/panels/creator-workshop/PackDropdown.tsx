import { useState, useRef, useEffect } from 'react'
import { ChevronDown, Plus, Package } from 'lucide-react'
import type { Pack } from '@/types/api'
import clsx from 'clsx'
import styles from './PackDropdown.module.css'

interface PackDropdownProps {
  packs: Pack[]
  selectedPackId: string | null
  onSelect: (packId: string) => void
  onCreateNew: () => void
}

export default function PackDropdown({ packs, selectedPackId, onSelect, onCreateNew }: PackDropdownProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const wrapperRef = useRef<HTMLDivElement>(null)

  const selectedPack = packs.find((p) => p.id === selectedPackId)
  const filtered = packs.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button
        type="button"
        className={clsx(styles.trigger, open && styles.triggerOpen)}
        onClick={() => setOpen(!open)}
      >
        <Package size={12} />
        <span className={clsx(styles.triggerLabel, !selectedPack && styles.triggerPlaceholder)}>
          {selectedPack?.name || 'Select pack...'}
        </span>
        <span className={clsx(styles.triggerChevron, open && styles.triggerChevronOpen)}>
          <ChevronDown size={12} />
        </span>
      </button>

      {open && (
        <div className={styles.dropdown}>
          {packs.length > 5 && (
            <input
              className={styles.searchInput}
              placeholder="Search packs..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
          )}
          {filtered.map((pack) => (
            <button
              key={pack.id}
              type="button"
              className={clsx(styles.option, pack.id === selectedPackId && styles.optionActive)}
              onClick={() => {
                onSelect(pack.id)
                setOpen(false)
                setSearch('')
              }}
            >
              {pack.name}
            </button>
          ))}
          <button
            type="button"
            className={clsx(styles.option, styles.createOption)}
            onClick={() => {
              onCreateNew()
              setOpen(false)
              setSearch('')
            }}
          >
            <Plus size={12} /> Create new pack...
          </button>
        </div>
      )}
    </div>
  )
}
