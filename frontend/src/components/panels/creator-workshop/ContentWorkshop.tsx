import { useState, useEffect, useCallback, useRef } from 'react'
import {
  User, ScrollText, Wrench, Plus, ChevronRight,
  Pencil, Trash2, Download, Upload, Package,
} from 'lucide-react'
import { useStore } from '@/store'
import { packsApi } from '@/api/packs'
import { normalizePackJson } from '@/utils/pack-transform'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import PackEditorModal from '@/components/panels/pack-browser/PackEditorModal'
import PackDropdown from './PackDropdown'
import type { Pack, PackWithItems, LumiaItem, LoomItem, LoomTool } from '@/types/api'
import clsx from 'clsx'
import styles from './ContentWorkshop.module.css'

const CATEGORY_LABELS: Record<string, string> = {
  narrative_style: 'Style',
  loom_utility: 'Utility',
  retrofit: 'Retrofit',
}

export default function ContentWorkshop() {
  const packs = useStore((s) => s.packs)
  const setPacks = useStore((s) => s.setPacks)
  const addPack = useStore((s) => s.addPack)
  const removePack = useStore((s) => s.removePack)
  const packsWithItems = useStore((s) => s.packsWithItems)
  const setPackWithItems = useStore((s) => s.setPackWithItems)
  const removePackWithItems = useStore((s) => s.removePackWithItems)
  const updatePackInStore = useStore((s) => s.updatePackInStore)
  const openModal = useStore((s) => s.openModal)

  const [loading, setLoading] = useState(true)
  const [editingPack, setEditingPack] = useState<Pack | null>(null)
  const [expandedPacks, setExpandedPacks] = useState<Set<string>>(new Set())
  const [loadingPacks, setLoadingPacks] = useState<Set<string>>(new Set())
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ type: 'pack' | 'lumia' | 'loom' | 'tool'; packId: string; itemId?: string; name: string } | null>(null)
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Load packs on mount
  useEffect(() => {
    const load = async () => {
      try {
        const result = await packsApi.list({ limit: 100 })
        setPacks(result.data)
        const customPacks = result.data.filter((p) => p.is_custom)
        if (customPacks.length > 0) {
          setSelectedPackId(customPacks[0].id)
        }
      } catch (err) {
        console.error('Failed to load packs:', err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [setPacks])

  const customPacks = packs.filter((p) => p.is_custom)

  const loadPackItems = useCallback(async (packId: string) => {
    if (loadingPacks.has(packId)) return
    setLoadingPacks((prev) => new Set(prev).add(packId))
    try {
      const data = await packsApi.get(packId)
      setPackWithItems(packId, data)
    } catch (err) {
      console.error('Failed to load pack items:', err)
    } finally {
      setLoadingPacks((prev) => {
        const next = new Set(prev)
        next.delete(packId)
        return next
      })
    }
  }, [loadingPacks, setPackWithItems])

  const togglePack = useCallback((packId: string) => {
    setExpandedPacks((prev) => {
      const next = new Set(prev)
      if (next.has(packId)) {
        next.delete(packId)
      } else {
        next.add(packId)
        if (!packsWithItems[packId]) {
          loadPackItems(packId)
        }
      }
      return next
    })
  }, [packsWithItems, loadPackItems])

  const refreshPack = useCallback(async (packId: string) => {
    const data = await packsApi.get(packId)
    setPackWithItems(packId, data)
  }, [setPackWithItems])

  const ensurePack = useCallback(async (): Promise<string> => {
    if (selectedPackId) return selectedPackId
    if (customPacks.length > 0) {
      setSelectedPackId(customPacks[0].id)
      return customPacks[0].id
    }
    const pack = await packsApi.create({ name: 'My Pack', is_custom: true })
    addPack(pack)
    setSelectedPackId(pack.id)
    return pack.id
  }, [selectedPackId, customPacks, addPack])

  const handleCreateNew = useCallback(async (type: 'lumia' | 'loom' | 'tool') => {
    const packId = await ensurePack()
    const onSaved = () => refreshPack(packId)
    const modalName = type === 'lumia' ? 'lumiaEditor' : type === 'loom' ? 'loomEditor' : 'toolEditor'
    openModal(modalName, { packId, onSaved })
  }, [ensurePack, openModal, refreshPack])

  const handleCreateNewInPack = useCallback((type: 'lumia' | 'loom' | 'tool', packId: string) => {
    const onSaved = () => refreshPack(packId)
    const modalName = type === 'lumia' ? 'lumiaEditor' : type === 'loom' ? 'loomEditor' : 'toolEditor'
    openModal(modalName, { packId, onSaved })
  }, [openModal, refreshPack])

  const handleEdit = useCallback((type: 'lumia' | 'loom' | 'tool', packId: string, item: LumiaItem | LoomItem | LoomTool) => {
    const onSaved = () => refreshPack(packId)
    const modalName = type === 'lumia' ? 'lumiaEditor' : type === 'loom' ? 'loomEditor' : 'toolEditor'
    openModal(modalName, { packId, editingItem: item, onSaved })
  }, [openModal, refreshPack])

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      if (deleteTarget.type === 'pack') {
        await packsApi.delete(deleteTarget.packId)
        removePack(deleteTarget.packId)
        removePackWithItems(deleteTarget.packId)
        if (selectedPackId === deleteTarget.packId) {
          setSelectedPackId(customPacks.find((p) => p.id !== deleteTarget.packId)?.id || null)
        }
      } else if (deleteTarget.type === 'lumia') {
        await packsApi.deleteLumiaItem(deleteTarget.packId, deleteTarget.itemId!)
        await refreshPack(deleteTarget.packId)
      } else if (deleteTarget.type === 'loom') {
        await packsApi.deleteLoomItem(deleteTarget.packId, deleteTarget.itemId!)
        await refreshPack(deleteTarget.packId)
      } else if (deleteTarget.type === 'tool') {
        await packsApi.deleteLoomTool(deleteTarget.packId, deleteTarget.itemId!)
        await refreshPack(deleteTarget.packId)
      }
    } catch (err) {
      console.error('Failed to delete:', err)
    }
    setDeleteTarget(null)
  }, [deleteTarget, removePack, removePackWithItems, selectedPackId, customPacks, refreshPack])

  const handleExport = useCallback(async (packId: string) => {
    try {
      const data = await packsApi.export(packId)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `pack-${packId}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Failed to export pack:', err)
    }
  }, [])

  const handleEditPackMeta = useCallback(async (data: { name: string; author: string; cover_url: string }) => {
    if (!editingPack) return
    try {
      const updated = await packsApi.update(editingPack.id, data)
      updatePackInStore(editingPack.id, updated)
      setEditingPack(null)
    } catch (err) {
      console.error('Failed to update pack:', err)
    }
  }, [editingPack, updatePackInStore])

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImporting(true)
    try {
      const text = await file.text()
      const raw = JSON.parse(text)
      const payload = normalizePackJson(raw)
      const result = await packsApi.importJson(payload)
      // Mark as custom so it appears in the Creator Workshop as editable
      await packsApi.update(result.id, { is_custom: true })
      const updated = { ...result, is_custom: true }
      addPack(updated)
      setPackWithItems(result.id, updated)
      setSelectedPackId(result.id)
      setExpandedPacks((prev) => new Set(prev).add(result.id))
    } catch (err) {
      console.error('Failed to import pack:', err)
    } finally {
      setImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [addPack, setPackWithItems])

  const handleCreatePack = useCallback(async () => {
    try {
      const pack = await packsApi.create({ name: 'New Pack', is_custom: true })
      addPack(pack)
      setSelectedPackId(pack.id)
    } catch (err) {
      console.error('Failed to create pack:', err)
    }
  }, [addPack])

  if (loading) {
    return <div className={styles.loading}>Loading...</div>
  }

  return (
    <div className={styles.workshop}>
      {/* Quick Create */}
      <div>
        <div className={styles.sectionTitle}>Quick Create</div>
        {customPacks.length > 1 && (
          <PackDropdown
            packs={customPacks}
            selectedPackId={selectedPackId}
            onSelect={setSelectedPackId}
            onCreateNew={handleCreatePack}
          />
        )}
        <div className={styles.quickCreateGrid}>
          <button type="button" className={styles.quickCard} onClick={() => handleCreateNew('lumia')}>
            <div className={styles.quickCardIcon}><User size={18} /></div>
            <span className={styles.quickCardLabel}>Lumia</span>
            <span className={styles.quickCardSub}>Character</span>
          </button>
          <button type="button" className={styles.quickCard} onClick={() => handleCreateNew('loom')}>
            <div className={styles.quickCardIcon}><ScrollText size={18} /></div>
            <span className={styles.quickCardLabel}>Loom</span>
            <span className={styles.quickCardSub}>Style / Utility</span>
          </button>
          <button type="button" className={styles.quickCard} onClick={() => handleCreateNew('tool')}>
            <div className={styles.quickCardIcon}><Wrench size={18} /></div>
            <span className={styles.quickCardLabel}>Tool</span>
            <span className={styles.quickCardSub}>Council Tool</span>
          </button>
        </div>
      </div>

      {/* My Packs */}
      <div>
        <div className={styles.sectionTitle}>My Packs</div>
        {customPacks.length === 0 ? (
          <div className={styles.emptyPacks}>No custom packs yet. Click a Quick Create card to get started.</div>
        ) : (
          customPacks.map((pack) => (
            <PackSection
              key={pack.id}
              pack={pack}
              expanded={expandedPacks.has(pack.id)}
              loading={loadingPacks.has(pack.id)}
              packData={packsWithItems[pack.id]}
              onToggle={() => togglePack(pack.id)}
              onEdit={() => setEditingPack(pack)}
              onExport={() => handleExport(pack.id)}
              onDelete={() => setDeleteTarget({ type: 'pack', packId: pack.id, name: pack.name })}
              onCreateItem={(type) => handleCreateNewInPack(type, pack.id)}
              onEditItem={(type, item) => handleEdit(type, pack.id, item)}
              onDeleteItem={(type, itemId, name) => setDeleteTarget({ type, packId: pack.id, itemId, name })}
            />
          ))
        )}
      </div>

      {/* Import / Export */}
      <div>
        <div className={styles.sectionTitle}>Import</div>
        <div className={styles.importSection}>
          <button
            type="button"
            className={styles.importBtn}
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
          >
            <Upload size={14} />
            {importing ? 'Importing...' : 'Import JSON Pack'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={handleImport}
          />
        </div>
      </div>

      {deleteTarget && (
        <ConfirmationModal
          isOpen
          title={`Delete ${deleteTarget.type === 'pack' ? 'pack' : 'item'}?`}
          message={`Are you sure you want to delete "${deleteTarget.name}"? This cannot be undone.`}
          variant="danger"
          confirmText="Delete"
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {editingPack && (
        <PackEditorModal
          initialData={editingPack}
          onSave={handleEditPackMeta}
          onClose={() => setEditingPack(null)}
        />
      )}
    </div>
  )
}

// --- Pack Section Sub-component ---

interface PackSectionProps {
  pack: Pack
  expanded: boolean
  loading: boolean
  packData?: PackWithItems
  onToggle: () => void
  onEdit: () => void
  onExport: () => void
  onDelete: () => void
  onCreateItem: (type: 'lumia' | 'loom' | 'tool') => void
  onEditItem: (type: 'lumia' | 'loom' | 'tool', item: LumiaItem | LoomItem | LoomTool) => void
  onDeleteItem: (type: 'lumia' | 'loom' | 'tool', itemId: string, name: string) => void
}

function PackSection({ pack, expanded, loading, packData, onToggle, onEdit, onExport, onDelete, onCreateItem, onEditItem, onDeleteItem }: PackSectionProps) {
  return (
    <div className={styles.packSection}>
      <div className={styles.packHeader} onClick={onToggle}>
        <span className={clsx(styles.packChevron, expanded && styles.packChevronOpen)}>
          <ChevronRight size={14} />
        </span>
        <span className={styles.packName}>{pack.name}</span>
        <div className={styles.packActions} onClick={(e) => e.stopPropagation()}>
          <button type="button" className={styles.packActionBtn} onClick={onEdit} title="Edit pack details">
            <Pencil size={13} />
          </button>
          <button type="button" className={styles.packActionBtn} onClick={onExport} title="Export">
            <Download size={13} />
          </button>
          <button type="button" className={clsx(styles.packActionBtn, styles.packActionBtnDanger)} onClick={onDelete} title="Delete pack">
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className={styles.packBody}>
          {loading ? (
            <div className={styles.emptyItems}>Loading...</div>
          ) : packData ? (
            <>
              {/* Lumia Items */}
              <ItemGroup
                label="Lumia"
                count={packData.lumia_items.length}
                onAdd={() => onCreateItem('lumia')}
              >
                {packData.lumia_items.length === 0 ? (
                  <div className={styles.emptyItems}>No lumia items</div>
                ) : (
                  packData.lumia_items.map((item) => (
                    <div key={item.id} className={styles.itemRow}>
                      {item.avatar_url ? (
                        <img className={styles.itemAvatar} src={item.avatar_url} alt="" />
                      ) : (
                        <div className={styles.itemAvatarFallback}>{item.name[0]}</div>
                      )}
                      <span className={styles.itemName}>{item.name}</span>
                      <div className={styles.itemActions}>
                        <button type="button" className={styles.itemActionBtn} onClick={() => onEditItem('lumia', item)} title="Edit">
                          <Pencil size={12} />
                        </button>
                        <button type="button" className={clsx(styles.itemActionBtn, styles.itemActionBtnDanger)} onClick={() => onDeleteItem('lumia', item.id, item.name)} title="Delete">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </ItemGroup>

              {/* Loom Items */}
              <ItemGroup
                label="Loom"
                count={packData.loom_items.length}
                onAdd={() => onCreateItem('loom')}
              >
                {packData.loom_items.length === 0 ? (
                  <div className={styles.emptyItems}>No loom items</div>
                ) : (
                  packData.loom_items.map((item) => (
                    <div key={item.id} className={styles.itemRow}>
                      <div className={styles.itemIcon}><ScrollText size={14} /></div>
                      <span className={styles.itemName}>{item.name}</span>
                      <span className={styles.itemBadge}>{CATEGORY_LABELS[item.category] || item.category}</span>
                      <div className={styles.itemActions}>
                        <button type="button" className={styles.itemActionBtn} onClick={() => onEditItem('loom', item)} title="Edit">
                          <Pencil size={12} />
                        </button>
                        <button type="button" className={clsx(styles.itemActionBtn, styles.itemActionBtnDanger)} onClick={() => onDeleteItem('loom', item.id, item.name)} title="Delete">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </ItemGroup>

              {/* Tools */}
              <ItemGroup
                label="Tools"
                count={packData.loom_tools.length}
                onAdd={() => onCreateItem('tool')}
              >
                {packData.loom_tools.length === 0 ? (
                  <div className={styles.emptyItems}>No tools</div>
                ) : (
                  packData.loom_tools.map((tool) => (
                    <div key={tool.id} className={styles.itemRow}>
                      <div className={styles.itemIcon}><Wrench size={14} /></div>
                      <span className={styles.itemName}>{tool.display_name || tool.tool_name}</span>
                      <div className={styles.itemActions}>
                        <button type="button" className={styles.itemActionBtn} onClick={() => onEditItem('tool', tool)} title="Edit">
                          <Pencil size={12} />
                        </button>
                        <button type="button" className={clsx(styles.itemActionBtn, styles.itemActionBtnDanger)} onClick={() => onDeleteItem('tool', tool.id, tool.display_name || tool.tool_name)} title="Delete">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </ItemGroup>
            </>
          ) : (
            <div className={styles.emptyItems}>Failed to load items</div>
          )}
        </div>
      )}
    </div>
  )
}

// --- Item Group Sub-component ---

interface ItemGroupProps {
  label: string
  count: number
  onAdd: () => void
  children: React.ReactNode
}

function ItemGroup({ label, count, onAdd, children }: ItemGroupProps) {
  return (
    <div className={styles.itemGroup}>
      <div className={styles.itemGroupHeader}>
        <span>{label}</span>
        <span className={styles.itemGroupCount}>({count})</span>
        <button type="button" className={styles.itemGroupAdd} onClick={onAdd} title={`Add ${label}`}>
          <Plus size={12} />
        </button>
      </div>
      {children}
    </div>
  )
}
