import { useState, useMemo, useCallback, useEffect } from 'react'
import { Search, X, Users, Plus } from 'lucide-react'
import type { CouncilMember } from 'lumiverse-spindle-types'
import type { Pack, PackWithItems, LumiaItem } from '@/types/api'
import { useStore } from '@/store'
import { packsApi } from '@/api/packs'
import useIsMobile from '@/hooks/useIsMobile'
import LazyImage from '@/components/shared/LazyImage'
import { generateUUID } from '@/lib/uuid'
import styles from '../CouncilManager.module.css'

interface AddMemberDropdownProps {
  existingMembers: CouncilMember[]
  onAdd: (member: CouncilMember) => void
  onClose: () => void
}

interface AvailableItem {
  packId: string
  packName: string
  itemId: string
  itemName: string
  avatarUrl: string | null
}

export default function AddMemberDropdown({ existingMembers, onAdd, onClose }: AddMemberDropdownProps) {
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

  // Collect all available Lumia items not already in council
  const availableItems = useMemo(() => {
    const items: AvailableItem[] = []
    for (const pack of packs) {
      const loaded = packsWithItems[pack.id] as PackWithItems | undefined
      if (!loaded?.lumia_items) continue
      for (const item of loaded.lumia_items) {
        if (!item.definition) continue
        if (existingSet.has(`${pack.id}:${item.id}`)) continue
        items.push({
          packId: pack.id,
          packName: pack.name,
          itemId: item.id,
          itemName: item.name,
          avatarUrl: item.avatar_url,
        })
      }
    }
    if (!searchTerm.trim()) return items
    const term = searchTerm.toLowerCase()
    return items.filter(
      (i) => i.itemName.toLowerCase().includes(term) || i.packName.toLowerCase().includes(term)
    )
  }, [packs, packsWithItems, existingSet, searchTerm])

  const handleSelect = useCallback(
    (item: AvailableItem) => {
      onAdd({
        id: generateUUID(),
        packId: item.packId,
        packName: item.packName,
        itemId: item.itemId,
        itemName: item.itemName,
        tools: [],
        role: '',
        chance: 100,
      })
    },
    [onAdd]
  )

  return (
    <div className={styles.addDropdown}>
      <div className={styles.addDropdownHeader}>
        <div className={styles.addSearchWrapper}>
          <Search size={13} />
          <input
            type="text"
            className={styles.addSearchInput}
            placeholder="Search Lumias..."
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
        ) : availableItems.length === 0 ? (
          <div className={styles.addDropdownEmpty}>
            {searchTerm ? 'No matching Lumias found' : 'All Lumias are already in the council'}
          </div>
        ) : (
          availableItems.map((item) => (
            <button
              key={`${item.packId}:${item.itemId}`}
              type="button"
              className={styles.addDropdownItem}
              onClick={() => handleSelect(item)}
            >
              <div className={styles.addDropdownAvatar}>
                <LazyImage
                  src={item.avatarUrl}
                  alt=""
                  spinnerSize={12}
                  fallback={<Users size={16} />}
                />
              </div>
              <div className={styles.addDropdownInfo}>
                <span className={styles.addDropdownName}>{item.itemName}</span>
                <span className={styles.addDropdownPack}>{item.packName}</span>
              </div>
              <Plus size={14} className={styles.addDropdownPlus} />
            </button>
          ))
        )}
      </div>
    </div>
  )
}
