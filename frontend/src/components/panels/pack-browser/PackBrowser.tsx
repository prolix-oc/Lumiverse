import { useState, useEffect, useCallback } from 'react'
import { Plus, Upload } from 'lucide-react'
import { useStore } from '@/store'
import { packsApi } from '@/api/packs'
import type { Pack, PackWithItems } from '@/types/api'
import type { PackFilterTab } from '@/types/store'
import PackCard from './PackCard'
import PackDetailView from './PackDetailView'
import PackEditorModal from './PackEditorModal'
import ImportPackModal from './ImportPackModal'
import styles from './PackBrowser.module.css'
import clsx from 'clsx'

const FILTER_TABS: { id: PackFilterTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'custom', label: 'Custom' },
  { id: 'downloaded', label: 'Downloaded' },
]

export default function PackBrowser() {
  const packs = useStore((s) => s.packs)
  const setPacks = useStore((s) => s.setPacks)
  const addPack = useStore((s) => s.addPack)
  const updatePackInStore = useStore((s) => s.updatePackInStore)
  const removePack = useStore((s) => s.removePack)
  const selectedPackId = useStore((s) => s.selectedPackId)
  const setSelectedPackId = useStore((s) => s.setSelectedPackId)
  const packSearchQuery = useStore((s) => s.packSearchQuery)
  const setPackSearchQuery = useStore((s) => s.setPackSearchQuery)
  const packFilterTab = useStore((s) => s.packFilterTab)
  const setPackFilterTab = useStore((s) => s.setPackFilterTab)

  const [detailPack, setDetailPack] = useState<PackWithItems | null>(null)
  const [showPackEditor, setShowPackEditor] = useState(false)
  const [editingPack, setEditingPack] = useState<Pack | null>(null)
  const [showImport, setShowImport] = useState(false)

  const loadPacks = useCallback(async () => {
    try {
      const res = await packsApi.list({ limit: 200 })
      setPacks(res.data)
    } catch {}
  }, [setPacks])

  useEffect(() => {
    loadPacks()
  }, [loadPacks])

  const loadDetail = useCallback(async (id: string) => {
    try {
      const pack = await packsApi.get(id)
      setDetailPack(pack)
      setSelectedPackId(id)
    } catch {}
  }, [setSelectedPackId])

  useEffect(() => {
    if (selectedPackId && !detailPack) {
      loadDetail(selectedPackId)
    }
  }, [selectedPackId, detailPack, loadDetail])

  const handleSelectPack = useCallback((pack: Pack) => {
    loadDetail(pack.id)
  }, [loadDetail])

  const handleBack = useCallback(() => {
    setDetailPack(null)
    setSelectedPackId(null)
  }, [setSelectedPackId])

  const handleCreatePack = useCallback(async (data: { name: string; author: string; cover_url: string }) => {
    try {
      const pack = await packsApi.create({ ...data, is_custom: true })
      addPack(pack)
      setShowPackEditor(false)
      handleSelectPack(pack)
    } catch {}
  }, [addPack, handleSelectPack])

  const handleUpdatePack = useCallback(async (data: { name: string; author: string; cover_url: string }) => {
    if (!editingPack) return
    try {
      const updated = await packsApi.update(editingPack.id, data)
      updatePackInStore(editingPack.id, updated)
      if (detailPack?.id === editingPack.id) {
        setDetailPack((prev) => prev ? { ...prev, ...updated } : null)
      }
      setEditingPack(null)
      setShowPackEditor(false)
    } catch {}
  }, [editingPack, updatePackInStore, detailPack])

  const handleDeletePack = useCallback(async (id: string) => {
    try {
      await packsApi.delete(id)
      removePack(id)
      if (selectedPackId === id) {
        setDetailPack(null)
        setSelectedPackId(null)
      }
    } catch {}
  }, [removePack, selectedPackId, setSelectedPackId])

  const handleImportDone = useCallback((pack: PackWithItems) => {
    loadPacks()
    setShowImport(false)
    setDetailPack(pack)
    setSelectedPackId(pack.id)
  }, [loadPacks, setSelectedPackId])

  const handleDetailRefresh = useCallback(() => {
    if (selectedPackId) loadDetail(selectedPackId)
  }, [selectedPackId, loadDetail])

  const filteredPacks = packs.filter((p) => {
    if (packFilterTab === 'custom' && !p.is_custom) return false
    if (packFilterTab === 'downloaded' && p.is_custom) return false
    if (packSearchQuery) {
      const q = packSearchQuery.toLowerCase()
      return p.name.toLowerCase().includes(q) || p.author.toLowerCase().includes(q)
    }
    return true
  })

  if (detailPack) {
    return (
      <div className={styles.panel}>
        <PackDetailView
          pack={detailPack}
          onBack={handleBack}
          onEdit={() => {
            setEditingPack(detailPack)
            setShowPackEditor(true)
          }}
          onDelete={() => handleDeletePack(detailPack.id)}
          onRefresh={handleDetailRefresh}
        />
        {showPackEditor && editingPack && (
          <PackEditorModal
            initialData={editingPack}
            onSave={handleUpdatePack}
            onClose={() => { setShowPackEditor(false); setEditingPack(null) }}
          />
        )}
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.toolbarTop}>
          <input
            type="text"
            className={styles.searchInput}
            placeholder="Search packs..."
            value={packSearchQuery}
            onChange={(e) => setPackSearchQuery(e.target.value)}
          />
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => setShowImport(true)}
            title="Import pack"
          >
            <Upload size={14} />
          </button>
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={() => { setEditingPack(null); setShowPackEditor(true) }}
          >
            <Plus size={13} />
            New
          </button>
        </div>
        <div className={styles.filterTabs}>
          {FILTER_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={clsx(styles.filterTab, packFilterTab === tab.id && styles.filterTabActive)}
              onClick={() => setPackFilterTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Pack grid */}
      <div className={styles.grid}>
        {filteredPacks.map((pack) => (
          <PackCard key={pack.id} pack={pack} onClick={handleSelectPack} />
        ))}
        {filteredPacks.length === 0 && (
          <div className={styles.emptyState}>No packs found</div>
        )}
      </div>

      {showPackEditor && !editingPack && (
        <PackEditorModal
          onSave={handleCreatePack}
          onClose={() => setShowPackEditor(false)}
        />
      )}

      {showImport && (
        <ImportPackModal
          onImport={handleImportDone}
          onClose={() => setShowImport(false)}
        />
      )}
    </div>
  )
}
