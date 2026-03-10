import { useState, useMemo, useCallback, useEffect } from 'react'
import { Search, X, Package } from 'lucide-react'
import type { CouncilMember } from 'lumiverse-spindle-types'
import type { PackWithItems } from '@/types/api'
import { useStore } from '@/store'
import { packsApi } from '@/api/packs'
import useIsMobile from '@/hooks/useIsMobile'
import LazyImage from '@/components/shared/LazyImage'
import styles from '../CouncilManager.module.css'

interface QuickAddPackDropdownProps {
  existingMembers: CouncilMember[]
  onAddPack: (packId: string) => void
  onClose: () => void
}

interface AvailablePack {
  packId: string
  packName: string
  coverUrl: string | null
  availableCount: number
}

export default function QuickAddPackDropdown({ existingMembers, onAddPack, onClose }: QuickAddPackDropdownProps) {
  const packs = useStore((s) => s.packs)
  const packsWithItems = useStore((s) => s.packsWithItems)
  const setPackWithItems = useStore((s) => s.setPackWithItems)
  const [searchTerm, setSearchTerm] = useState('')
  const [loadingPacks, setLoadingPacks] = useState(false)
  const isMobile = useIsMobile()

  // Ensure all packs have their items loaded
  useEffect(() => {
    const unloaded = packs.filter((p) => !packsWithItems[p.id])
    if (unloaded.length === 0) return
    setLoadingPacks(true)
    Promise.all(
      unloaded.map((p) =>
        packsApi.get(p.id).then((data) => setPackWithItems(p.id, data)).catch(() => {})
      )
    ).finally(() => setLoadingPacks(false))
  }, [packs, packsWithItems, setPackWithItems])

  // Build set of existing members for dedup
  const existingSet = useMemo(
    () => new Set(existingMembers.map((m) => `${m.packId}:${m.itemId}`)),
    [existingMembers]
  )

  // Get packs with available (not-yet-added) Lumia counts
  const availablePacks = useMemo(() => {
    const result: AvailablePack[] = []
    for (const pack of packs) {
      const loaded = packsWithItems[pack.id] as PackWithItems | undefined
      if (!loaded?.lumia_items) continue
      const availableCount = loaded.lumia_items.filter(
        (item) => item.definition && !existingSet.has(`${pack.id}:${item.id}`)
      ).length
      if (availableCount === 0) continue
      result.push({
        packId: pack.id,
        packName: pack.name,
        coverUrl: pack.cover_url || null,
        availableCount,
      })
    }
    if (!searchTerm.trim()) return result
    const term = searchTerm.toLowerCase()
    return result.filter((p) => p.packName.toLowerCase().includes(term))
  }, [packs, packsWithItems, existingSet, searchTerm])

  const handleSelect = useCallback(
    (packId: string) => {
      onAddPack(packId)
      onClose()
    },
    [onAddPack, onClose]
  )

  return (
    <div className={styles.addDropdown}>
      <div className={styles.addDropdownHeader}>
        <div className={styles.addSearchWrapper}>
          <Search size={13} />
          <input
            type="text"
            className={styles.addSearchInput}
            placeholder="Search packs..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            autoFocus={!isMobile}
          />
          {searchTerm && (
            <button type="button" className={styles.addSearchClear} onClick={() => setSearchTerm('')}>
              <X size={11} />
            </button>
          )}
        </div>
        <button type="button" className={styles.addDropdownClose} onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className={styles.addDropdownList}>
        {loadingPacks ? (
          <div className={styles.addDropdownEmpty}>Loading packs...</div>
        ) : availablePacks.length === 0 ? (
          <div className={styles.addDropdownEmpty}>
            {searchTerm ? 'No matching packs found' : 'All packs are fully added'}
          </div>
        ) : (
          availablePacks.map((pack) => (
            <button
              key={pack.packId}
              type="button"
              className={styles.addDropdownItem}
              onClick={() => handleSelect(pack.packId)}
            >
              <div className={styles.addDropdownAvatar}>
                <LazyImage
                  src={pack.coverUrl}
                  alt=""
                  spinnerSize={12}
                  fallback={<Package size={16} />}
                />
              </div>
              <div className={styles.addDropdownInfo}>
                <span className={styles.addDropdownName}>{pack.packName}</span>
                <span className={styles.addDropdownPack}>
                  {pack.availableCount} Lumia{pack.availableCount !== 1 ? 's' : ''} available
                </span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
