import { useState, useEffect, useCallback, useRef } from 'react'
import { Plus, Check, Trash2 } from 'lucide-react'
import { IconPlaylistAdd } from '@tabler/icons-react'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button } from '@/components/shared/FormComponents'
import { useStore } from '@/store'
import { personasApi } from '@/api/personas'
import { toast } from '@/lib/toast'
import { ExpandableTextarea } from '@/components/shared/ExpandedTextEditor'
import type { PersonaAddon } from '@/types/api'
import styles from './PersonaAddonsModal.module.css'
import { uuidv7 } from '@/lib/uuid'
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
      id: uuidv7(),
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

  return (
    <ModalShell isOpen={true} onClose={closeModal} maxWidth={560} className={styles.modal}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <IconPlaylistAdd size={16} className={styles.headerIcon} />
          <span className={styles.title}>
            {personaName ? `${personaName} — Add-Ons` : 'Persona Add-Ons'}
          </span>
        </div>
        <CloseButton onClick={closeModal} size="sm" />
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
        <Button variant="primary" icon={<Plus size={13} />} onClick={handleAdd}>
          Add Add-On
        </Button>
        <span className={styles.addonCount}>
          {addons.length} add-on{addons.length !== 1 ? 's' : ''}
          {addons.filter((a) => a.enabled).length > 0 && ` (${addons.filter((a) => a.enabled).length} active)`}
        </span>
      </div>
    </ModalShell>
  )
}
