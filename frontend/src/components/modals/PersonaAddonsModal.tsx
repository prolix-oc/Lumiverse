import { useState, useEffect, useCallback, useRef } from 'react'
import { Plus, Check, Trash2, Globe, Link2, Unlink } from 'lucide-react'
import { IconPlaylistAdd } from '@tabler/icons-react'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button } from '@/components/shared/FormComponents'
import { useStore } from '@/store'
import { personasApi } from '@/api/personas'
import { globalAddonsApi } from '@/api/global-addons'
import { toast } from '@/lib/toast'
import { ExpandableTextarea } from '@/components/shared/ExpandedTextEditor'
import type { PersonaAddon, GlobalAddon, AttachedGlobalAddon } from '@/types/api'
import styles from './PersonaAddonsModal.module.css'
import { uuidv7 } from '@/lib/uuid'
import clsx from 'clsx'

export default function PersonaAddonsModal() {
  const modalProps = useStore((s) => s.modalProps)
  const closeModal = useStore((s) => s.closeModal)
  const openModal = useStore((s) => s.openModal)
  const updatePersonaInStore = useStore((s) => s.updatePersona)

  const personaId = modalProps?.personaId as string
  const personaName = modalProps?.personaName as string | undefined

  const [addons, setAddons] = useState<PersonaAddon[]>([])
  const [metadata, setMetadata] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(true)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Global add-on state
  const [allGlobalAddons, setAllGlobalAddons] = useState<GlobalAddon[]>([])
  const [attachedRefs, setAttachedRefs] = useState<AttachedGlobalAddon[]>([])
  const [showAttachPicker, setShowAttachPicker] = useState(false)

  // Load persona data + global addons
  useEffect(() => {
    if (!personaId) return
    Promise.all([
      personasApi.get(personaId),
      globalAddonsApi.list({ limit: 200, offset: 0 }),
    ])
      .then(([p, globalRes]) => {
        setMetadata(p.metadata || {})
        const raw = p.metadata?.addons
        setAddons(Array.isArray(raw) ? raw : [])
        const refs = p.metadata?.attached_global_addons
        setAttachedRefs(Array.isArray(refs) ? refs : [])
        setAllGlobalAddons(globalRes.data)
      })
      .catch(() => toast.error('Failed to load persona'))
      .finally(() => setLoading(false))
  }, [personaId])

  // Debounced save helper for persona-specific addons
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

  // Save helper for attached global addon refs
  const persistAttachedRefs = useCallback(async (next: AttachedGlobalAddon[]) => {
    try {
      const newMeta = { ...metadata, attached_global_addons: next }
      const updated = await personasApi.update(personaId, { metadata: newMeta })
      setMetadata(updated.metadata || newMeta)
      setAttachedRefs(next)
      updatePersonaInStore(personaId, updated)
    } catch {
      toast.error('Failed to save global add-on attachment')
    }
  }, [personaId, metadata, updatePersonaInStore])

  // Persona-specific addon handlers
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

  // Global addon handlers
  const handleAttachGlobal = useCallback((globalAddonId: string) => {
    const next = [...attachedRefs, { id: globalAddonId, enabled: true }]
    setAttachedRefs(next)
    persistAttachedRefs(next)
    setShowAttachPicker(false)
  }, [attachedRefs, persistAttachedRefs])

  const handleDetachGlobal = useCallback((globalAddonId: string) => {
    const next = attachedRefs.filter((a) => a.id !== globalAddonId)
    setAttachedRefs(next)
    persistAttachedRefs(next)
  }, [attachedRefs, persistAttachedRefs])

  const handleToggleGlobal = useCallback((globalAddonId: string) => {
    const next = attachedRefs.map((a) => a.id === globalAddonId ? { ...a, enabled: !a.enabled } : a)
    setAttachedRefs(next)
    persistAttachedRefs(next)
  }, [attachedRefs, persistAttachedRefs])

  // Resolved global addons (attached refs joined with full data)
  const attachedGlobalAddons = attachedRefs
    .map((ref) => {
      const addon = allGlobalAddons.find((g) => g.id === ref.id)
      return addon ? { ...addon, enabled: ref.enabled } : null
    })
    .filter(Boolean) as (GlobalAddon & { enabled: boolean })[]

  // Unattached global addons for the picker
  const attachedIds = new Set(attachedRefs.map((a) => a.id))
  const unattachedGlobalAddons = allGlobalAddons.filter((g) => !attachedIds.has(g.id))

  if (!personaId) return null

  return (
    <ModalShell isOpen={true} onClose={closeModal} maxWidth={580} className={styles.modal}>
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

        {!loading && (
          <>
            {/* ── Section 1: Persona-Specific Add-Ons ── */}
            <div className={styles.sectionHeader}>
              <IconPlaylistAdd size={13} className={styles.sectionIconPersona} />
              <span>Persona Add-Ons</span>
            </div>

            {addons.length === 0 && (
              <div className={styles.emptySection}>
                No persona-specific add-ons. These are exclusive to this persona.
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

            <div className={styles.sectionAddRow}>
              <Button variant="ghost" icon={<Plus size={13} />} onClick={handleAdd} className={styles.sectionAddBtn}>
                Add Persona Add-On
              </Button>
            </div>

            {/* ── Divider ── */}
            <div className={styles.sectionDivider} />

            {/* ── Section 2: Global Add-Ons ── */}
            <div className={styles.sectionHeader}>
              <Globe size={13} className={styles.sectionIconGlobal} />
              <span>Global Add-Ons</span>
              <button
                type="button"
                className={styles.manageLibraryBtn}
                onClick={() => openModal('globalAddonsLibrary')}
              >
                Manage Library
              </button>
            </div>

            {attachedGlobalAddons.length === 0 && (
              <div className={styles.emptySection}>
                No global add-ons attached. Attach from your library to reuse across personas.
              </div>
            )}

            {attachedGlobalAddons.map((addon) => (
              <div key={addon.id} className={clsx(styles.addonCard, styles.addonCardGlobal, !addon.enabled && styles.addonCardDisabled)}>
                <div className={styles.addonTopRow}>
                  <button
                    type="button"
                    className={clsx(styles.addonToggle, addon.enabled && styles.addonToggleActiveGlobal)}
                    onClick={() => handleToggleGlobal(addon.id)}
                    title={addon.enabled ? 'Disable add-on' : 'Enable add-on'}
                  >
                    <Check size={13} />
                  </button>
                  <div className={styles.globalIndicator}>
                    <Globe size={10} />
                  </div>
                  <span className={styles.globalAddonLabel}>{addon.label || 'Untitled global add-on'}</span>
                  <button
                    type="button"
                    className={styles.detachBtn}
                    onClick={() => handleDetachGlobal(addon.id)}
                    title="Detach from persona"
                  >
                    <Unlink size={13} />
                  </button>
                </div>
                {addon.content && (
                  <div className={styles.globalAddonPreview}>
                    {addon.content.length > 200 ? addon.content.slice(0, 200) + '...' : addon.content}
                  </div>
                )}
              </div>
            ))}

            {/* Attach picker */}
            <div className={styles.sectionAddRow}>
              <div className={styles.attachWrapper}>
                <Button
                  variant="ghost"
                  icon={<Link2 size={13} />}
                  onClick={() => setShowAttachPicker((p) => !p)}
                  className={styles.sectionAddBtn}
                  disabled={unattachedGlobalAddons.length === 0}
                >
                  Attach Global Add-On
                </Button>
                {showAttachPicker && unattachedGlobalAddons.length > 0 && (
                  <div className={styles.attachPopover}>
                    {unattachedGlobalAddons.map((g) => (
                      <button
                        key={g.id}
                        type="button"
                        className={styles.attachPopoverItem}
                        onClick={() => handleAttachGlobal(g.id)}
                      >
                        <Globe size={11} className={styles.attachPopoverIcon} />
                        <span>{g.label || 'Untitled'}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Footer */}
      <div className={styles.footer}>
        <span className={styles.addonCount}>
          {addons.length} persona{addons.length !== 1 ? '' : ''} / {attachedGlobalAddons.length} global
          {' '}&middot;{' '}
          {addons.filter((a) => a.enabled).length + attachedGlobalAddons.filter((a) => a.enabled).length} active
        </span>
      </div>
    </ModalShell>
  )
}
