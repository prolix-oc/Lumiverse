import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Save, ChevronDown, MoreVertical, RefreshCw, Trash2, Link, Unlink, Pencil, Check, X } from 'lucide-react'
import { useStore } from '@/store'
import { loadoutsApi } from '@/api/loadouts'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { toast } from '@/lib/toast'
import type { Loadout, LoadoutBinding } from '@/api/loadouts'
import styles from './LoadoutSelector.module.css'
import clsx from 'clsx'

export default function LoadoutSelector() {
  const { t } = useTranslation('panels')
  const loadouts = useStore((s) => s.loadouts)
  const activeLoadoutId = useStore((s) => s.activeLoadoutId)
  const loadLoadouts = useStore((s) => s.loadLoadouts)
  const createLoadout = useStore((s) => s.createLoadout)
  const updateLoadout = useStore((s) => s.updateLoadout)
  const deleteLoadout = useStore((s) => s.deleteLoadout)
  const applyLoadout = useStore((s) => s.applyLoadout)
  const setActiveLoadoutId = useStore((s) => s.setActiveLoadoutId)
  const activeChatId = useStore((s) => s.activeChatId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)

  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [chatBinding, setChatBinding] = useState<LoadoutBinding | null>(null)
  const [charBinding, setCharBinding] = useState<LoadoutBinding | null>(null)

  const dropdownRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Load loadouts on mount
  useEffect(() => { loadLoadouts() }, [loadLoadouts])

  // Load bindings when chat/character changes
  useEffect(() => {
    if (activeChatId) {
      loadoutsApi.getChatBinding(activeChatId).then(setChatBinding).catch(() => setChatBinding(null))
    } else {
      setChatBinding(null)
    }
  }, [activeChatId])

  useEffect(() => {
    if (activeCharacterId) {
      loadoutsApi.getCharacterBinding(activeCharacterId).then(setCharBinding).catch(() => setCharBinding(null))
    } else {
      setCharBinding(null)
    }
  }, [activeCharacterId])

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setDropdownOpen(false)
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const activeLoadout = loadouts.find((l) => l.id === activeLoadoutId)

  const handleSelect = useCallback(async (loadout: Loadout) => {
    setDropdownOpen(false)
    await applyLoadout(loadout.id)
    toast.success(t('loadoutSelector.applied', { name: loadout.name }))
  }, [applyLoadout, t])

  const handleSelectCustom = useCallback(() => {
    setDropdownOpen(false)
    setActiveLoadoutId(null)
  }, [setActiveLoadoutId])

  const handleSave = useCallback(async () => {
    if (!saveName.trim()) return
    const loadout = await createLoadout(saveName.trim())
    if (loadout) {
      toast.success(t('loadoutSelector.saved', { name: loadout.name }))
      setActiveLoadoutId(loadout.id)
    }
    setSaving(false)
    setSaveName('')
  }, [saveName, createLoadout, setActiveLoadoutId, t])

  const handleRecapture = useCallback(async () => {
    if (!activeLoadoutId) return
    await updateLoadout(activeLoadoutId, { recapture: true })
    toast.success(t('loadoutSelector.recaptured'))
    setMenuOpen(false)
  }, [activeLoadoutId, updateLoadout, t])

  const handleDelete = useCallback(async () => {
    if (!activeLoadoutId) return
    const name = activeLoadout?.name
    setConfirmDelete(false)
    await deleteLoadout(activeLoadoutId)
    toast.success(t('loadoutSelector.deleted', { name }))
  }, [activeLoadoutId, activeLoadout, deleteLoadout, t])

  const handleRename = useCallback(async () => {
    if (!renaming || !renameName.trim()) return
    await updateLoadout(renaming, { name: renameName.trim() })
    setRenaming(null)
    setRenameName('')
    setMenuOpen(false)
  }, [renaming, renameName, updateLoadout])

  const handleBindChat = useCallback(async () => {
    if (!activeChatId || !activeLoadoutId) return
    try {
      const binding = await loadoutsApi.setChatBinding(activeChatId, activeLoadoutId)
      setChatBinding(binding)
      toast.success(t('loadoutSelector.boundChat'))
    } catch {
      toast.error(t('loadoutSelector.bindFailed'))
    }
    setMenuOpen(false)
  }, [activeChatId, activeLoadoutId, t])

  const handleUnbindChat = useCallback(async () => {
    if (!activeChatId) return
    try {
      await loadoutsApi.deleteChatBinding(activeChatId)
      setChatBinding(null)
      toast.success(t('loadoutSelector.unboundChat'))
    } catch {
      toast.error(t('loadoutSelector.unbindFailed'))
    }
    setMenuOpen(false)
  }, [activeChatId, t])

  const handleBindCharacter = useCallback(async () => {
    if (!activeCharacterId || !activeLoadoutId) return
    try {
      const binding = await loadoutsApi.setCharacterBinding(activeCharacterId, activeLoadoutId)
      setCharBinding(binding)
      toast.success(t('loadoutSelector.boundCharacter'))
    } catch {
      toast.error(t('loadoutSelector.bindFailed'))
    }
    setMenuOpen(false)
  }, [activeCharacterId, activeLoadoutId, t])

  const handleUnbindCharacter = useCallback(async () => {
    if (!activeCharacterId) return
    try {
      await loadoutsApi.deleteCharacterBinding(activeCharacterId)
      setCharBinding(null)
      toast.success(t('loadoutSelector.unboundCharacter'))
    } catch {
      toast.error(t('loadoutSelector.unbindFailed'))
    }
    setMenuOpen(false)
  }, [activeCharacterId, t])

  return (
    <div className={styles.container}>
      <div className={styles.row}>
        {/* Dropdown selector */}
        <div className={styles.selectorWrap} ref={dropdownRef}>
          <button
            type="button"
            className={styles.selector}
            onClick={() => setDropdownOpen(!dropdownOpen)}
          >
            <span className={styles.selectorLabel}>
              {activeLoadout ? activeLoadout.name : t('loadoutSelector.custom')}
            </span>
            <ChevronDown size={12} className={clsx(styles.chevron, dropdownOpen && styles.chevronOpen)} />
          </button>

          {dropdownOpen && (
            <div className={styles.dropdown}>
              <button
                type="button"
                className={clsx(styles.dropdownItem, !activeLoadoutId && styles.dropdownItemActive)}
                onClick={handleSelectCustom}
              >
                {t('loadoutSelector.custom')}
              </button>
              {loadouts.map((loadout) => (
                <button
                  key={loadout.id}
                  type="button"
                  className={clsx(styles.dropdownItem, activeLoadoutId === loadout.id && styles.dropdownItemActive)}
                  onClick={() => handleSelect(loadout)}
                >
                  {renaming === loadout.id ? (
                    <div className={styles.renameRow} onClick={(e) => e.stopPropagation()}>
                      <input
                        className={styles.renameInput}
                        value={renameName}
                        onChange={(e) => setRenameName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setRenaming(null) }}
                        autoFocus
                      />
                      <button type="button" className={styles.renameBtn} onClick={handleRename}><Check size={11} /></button>
                      <button type="button" className={styles.renameBtn} onClick={() => setRenaming(null)}><X size={11} /></button>
                    </div>
                  ) : (
                    loadout.name
                  )}
                </button>
              ))}
              {loadouts.length === 0 && (
                <div className={styles.dropdownEmpty}>{t('loadoutSelector.noSaved')}</div>
              )}
            </div>
          )}
        </div>

        {/* Save button */}
        {saving ? (
          <div className={styles.saveRow}>
            <input
              className={styles.saveInput}
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') { setSaving(false); setSaveName('') } }}
              placeholder={t('loadoutSelector.namePlaceholder')}
              autoFocus
            />
            <button type="button" className={styles.saveConfirm} onClick={handleSave} disabled={!saveName.trim()}>
              <Check size={12} />
            </button>
            <button type="button" className={styles.saveCancel} onClick={() => { setSaving(false); setSaveName('') }}>
              <X size={12} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={styles.saveBtn}
            onClick={() => setSaving(true)}
            title={t('loadoutSelector.saveTitle')}
          >
            <Save size={12} />
          </button>
        )}

        {/* Menu button (only when a loadout is active) */}
        {activeLoadoutId && (
          <div className={styles.menuWrap} ref={menuRef}>
            <button
              type="button"
              className={styles.menuBtn}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <MoreVertical size={12} />
            </button>

            {menuOpen && (
              <div className={styles.menu}>
                <button type="button" className={styles.menuItem} onClick={() => {
                  setRenaming(activeLoadoutId)
                  setRenameName(activeLoadout?.name || '')
                  setMenuOpen(false)
                  setDropdownOpen(true)
                }}>
                  <Pencil size={11} /> {t('loadoutSelector.rename')}
                </button>
                <button type="button" className={styles.menuItem} onClick={handleRecapture}>
                  <RefreshCw size={11} /> {t('loadoutSelector.recapture')}
                </button>
                {activeChatId && (
                  chatBinding?.loadout_id === activeLoadoutId ? (
                    <button type="button" className={styles.menuItem} onClick={handleUnbindChat}>
                      <Unlink size={11} /> {t('loadoutSelector.unbindChat')}
                    </button>
                  ) : (
                    <button type="button" className={styles.menuItem} onClick={handleBindChat}>
                      <Link size={11} /> {t('loadoutSelector.bindChat')}
                    </button>
                  )
                )}
                {activeCharacterId && (
                  charBinding?.loadout_id === activeLoadoutId ? (
                    <button type="button" className={styles.menuItem} onClick={handleUnbindCharacter}>
                      <Unlink size={11} /> {t('loadoutSelector.unbindCharacter')}
                    </button>
                  ) : (
                    <button type="button" className={styles.menuItem} onClick={handleBindCharacter}>
                      <Link size={11} /> {t('loadoutSelector.bindCharacter')}
                    </button>
                  )
                )}
                <button type="button" className={clsx(styles.menuItem, styles.menuItemDanger)} onClick={() => { setMenuOpen(false); setConfirmDelete(true) }}>
                  <Trash2 size={11} /> {t('loadoutSelector.delete')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {confirmDelete && (
        <ConfirmationModal
          isOpen={true}
          title={t('loadoutSelector.deleteConfirmTitle')}
          message={t('loadoutSelector.deleteConfirmMessage', { name: activeLoadout?.name })}
          variant="danger"
          confirmText={t('loadoutSelector.delete')}
          onConfirm={() => { void handleDelete() }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  )
}
