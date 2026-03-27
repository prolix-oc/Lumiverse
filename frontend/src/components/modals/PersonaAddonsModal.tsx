import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { X, Puzzle, Plus, Check, Trash2 } from 'lucide-react'
import { useStore } from '@/store'
import { personasApi } from '@/api/personas'
import { toast } from '@/lib/toast'
import { ExpandableTextarea } from '@/components/shared/ExpandedTextEditor'
import type { PersonaAddon } from '@/types/api'
import styles from './PersonaAddonsModal.module.css'
import clsx from 'clsx'

export default function PersonaAddonsModal() {
  const modalProps = useStore((s) => s.modalProps)
  const closeModal = useStore((s) => s.closeModal)
  const updatePersonaInStore = useStore((s) => s.updatePersona)

  const personaId = modalProps?.personaId as string
  const personaName = modalProps?.personaName as string | undefined

  const [addons, setAddons] = useState<PersonaAddon[]>([])
  const [metadata, setMetadata] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(true)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const mouseDownTargetRef = useRef<EventTarget | null>(null)

  // Load persona data
  useEffect(() => {
    if (!personaId) return
    personasApi.get(personaId)
      .then((p) => {
        setMetadata(p.metadata || {})
        const raw = p.metadata?.addons
        setAddons(Array.isArray(raw) ? raw : [])
      })
      .catch(() => toast.error('Failed to load persona'))
      .finally(() => setLoading(false))
  }, [personaId])

  // Debounced save helper
  const persistAddons = useCallback((next: PersonaAddon[]) => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      try {
        const newMeta = { ...metadata, addons: next }
        const updated = await personasApi.update(personaId, { metadata: newMeta })
        setMetadata(updated.metadata || newMeta)
        updatePersonaInStore(personaId, updated)
      } catch {
        toast.error('Failed to save add-ons')
      }
    }, 300)
  }, [personaId, metadata, updatePersonaInStore])

  const handleAdd = useCallback(() => {
    const newAddon: PersonaAddon = {
      id: crypto.randomUUID(),
      label: '',
      content: '',
      enabled: true,
      sort_order: addons.length,
    }
    const next = [...addons, newAddon]
    setAddons(next)
    persistAddons(next)
  }, [addons, persistAddons])

  const handleToggle = useCallback((id: string) => {
    const next = addons.map((a) => a.id === id ? { ...a, enabled: !a.enabled } : a)
    setAddons(next)
    persistAddons(next)
  }, [addons, persistAddons])

  const handleDelete = useCallback((id: string) => {
    const next = addons.filter((a) => a.id !== id)
    setAddons(next)
    persistAddons(next)
  }, [addons, persistAddons])

  const handleLabelChange = useCallback((id: string, label: string) => {
    const next = addons.map((a) => a.id === id ? { ...a, label } : a)
    setAddons(next)
    persistAddons(next)
  }, [addons, persistAddons])

  const handleContentChange = useCallback((id: string, content: string) => {
    const next = addons.map((a) => a.id === id ? { ...a, content } : a)
    setAddons(next)
    persistAddons(next)
  }, [addons, persistAddons])

  if (!personaId) return null

  return createPortal(
    <motion.div
      className={styles.overlay}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onMouseDown={(e) => { mouseDownTargetRef.current = e.target }}
      onClick={(e) => { if (e.target === e.currentTarget && mouseDownTargetRef.current === e.currentTarget) closeModal() }}
    >
      <motion.div
        className={styles.modal}
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={{ duration: 0.18 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <Puzzle size={16} className={styles.headerIcon} />
            <span className={styles.title}>
              {personaName ? `${personaName} — Add-Ons` : 'Persona Add-Ons'}
            </span>
          </div>
          <button type="button" className={styles.closeBtn} onClick={closeModal}>
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className={styles.body}>
          {loading && <div className={styles.empty}>Loading...</div>}
          {!loading && addons.length === 0 && (
            <div className={styles.empty}>
              No add-ons yet. Add-ons inject extra content into your persona description
              when enabled — useful for clothing, equipment, transformations, or other
              on-the-fly customization.
            </div>
          )}
          {addons.map((addon) => (
            <div key={addon.id} className={clsx(styles.addonCard, !addon.enabled && styles.addonCardDisabled)}>
              <div className={styles.addonTopRow}>
                <button
                  type="button"
                  className={clsx(styles.addonToggle, addon.enabled && styles.addonToggleActive)}
                  onClick={() => handleToggle(addon.id)}
                  title={addon.enabled ? 'Disable add-on' : 'Enable add-on'}
                >
                  <Check size={13} />
                </button>
                <input
                  type="text"
                  className={styles.addonLabelInput}
                  value={addon.label}
                  onChange={(e) => handleLabelChange(addon.id, e.target.value)}
                  placeholder="Add-on name..."
                />
                <button
                  type="button"
                  className={styles.addonDeleteBtn}
                  onClick={() => handleDelete(addon.id)}
                  title="Delete add-on"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <ExpandableTextarea
                className={styles.addonContent}
                value={addon.content}
                onChange={(v) => handleContentChange(addon.id, v)}
                title={addon.label || 'Add-On Content'}
                placeholder="Add-on content (appended to persona description when enabled)..."
                rows={2}
              />
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          <button type="button" className={styles.addBtn} onClick={handleAdd}>
            <Plus size={13} />
            <span>Add Add-On</span>
          </button>
          <span className={styles.addonCount}>
            {addons.length} add-on{addons.length !== 1 ? 's' : ''}
            {addons.filter((a) => a.enabled).length > 0 && ` (${addons.filter((a) => a.enabled).length} active)`}
          </span>
        </div>
      </motion.div>
    </motion.div>,
    document.body
  )
}
