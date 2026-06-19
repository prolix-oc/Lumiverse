import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Check, Trash2, Globe, Link2, Unlink, GripVertical } from 'lucide-react'
import { IconPlaylistAdd } from '@tabler/icons-react'
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { useScaledSortableStyle } from '@/lib/dndUiScale'
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
  const { t } = useTranslation('modals', { keyPrefix: 'personaAddons' })
  const { t: tc } = useTranslation('common')

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
      .catch(() => toast.error(t('loadFailed')))
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
        toast.error(t('saveFailed'))
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
      toast.error(t('saveAttachmentFailed'))
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

  // Drag-to-reorder for persona-specific addons. `sort_order` is also re-stamped
  // so the backend MacroEnv resolves them in the visual order.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = addons.findIndex((a) => a.id === active.id)
    const newIndex = addons.findIndex((a) => a.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const moved = arrayMove(addons, oldIndex, newIndex)
    const next = moved.map((a, i) => ({ ...a, sort_order: i }))
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
            {personaName ? t('titleWithPersona', { name: personaName }) : t('title')}
          </span>
        </div>
        <CloseButton onClick={closeModal} size="sm" />
      </div>

      {/* Body */}
      <div className={styles.body}>
        {loading && <div className={styles.empty}>{t('loading')}</div>}

        {!loading && (
          <>
            {/* ── Section 1: Persona-Specific Add-Ons ── */}
            <div className={styles.sectionHeader}>
              <IconPlaylistAdd size={13} className={styles.sectionIconPersona} />
              <span>{t('personaSectionDefault')}</span>
            </div>
            <div className={styles.sectionHint}>
              {t('personaSectionHint')}
            </div>

            {addons.length === 0 && (
              <div className={styles.emptySection}>
                {t('personaEmpty')}
              </div>
            )}

            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={addons.map((a) => a.id)} strategy={verticalListSortingStrategy}>
                {addons.map((addon) => (
                  <SortableAddonRow
                    key={addon.id}
                    addon={addon}
                    onToggle={handleToggle}
                    onDelete={handleDelete}
                    onLabelChange={handleLabelChange}
                    onContentChange={handleContentChange}
                  />
                ))}
              </SortableContext>
            </DndContext>

            <div className={styles.sectionAddRow}>
              <Button variant="ghost" icon={<Plus size={13} />} onClick={handleAdd} className={styles.sectionAddBtn}>
                {t('addPersonaAddon')}
              </Button>
            </div>

            {/* ── Divider ── */}
            <div className={styles.sectionDivider} />

            {/* ── Section 2: Global Add-Ons ── */}
            <div className={styles.sectionHeader}>
              <Globe size={13} className={styles.sectionIconGlobal} />
              <span>{t('globalSection')}</span>
              <button
                type="button"
                className={styles.manageLibraryBtn}
                onClick={() => openModal('globalAddonsLibrary')}
              >
                {t('manageLibrary')}
              </button>
            </div>

            {attachedGlobalAddons.length === 0 && (
              <div className={styles.emptySection}>
                {t('globalEmpty')}
              </div>
            )}

            {attachedGlobalAddons.map((addon) => (
              <div key={addon.id} className={clsx(styles.addonCard, styles.addonCardGlobal, !addon.enabled && styles.addonCardDisabled)}>
                <div className={styles.addonTopRow}>
                  <button
                    type="button"
                    className={clsx(styles.addonToggle, addon.enabled && styles.addonToggleActiveGlobal)}
                    onClick={() => handleToggleGlobal(addon.id)}
                    title={addon.enabled ? t('disableAddon') : t('enableAddon')}
                  >
                    <Check size={13} />
                  </button>
                  <div className={styles.globalIndicator}>
                    <Globe size={10} />
                  </div>
                  <span className={styles.globalAddonLabel}>{addon.label || t('untitledGlobal')}</span>
                  <button
                    type="button"
                    className={styles.detachBtn}
                    onClick={() => handleDetachGlobal(addon.id)}
                    title={t('detachTitle')}
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
                  {t('attachGlobalAddon')}
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
                        <span>{g.label || t('untitled')}</span>
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

interface SortableAddonRowProps {
  addon: PersonaAddon
  onToggle: (id: string) => void
  onDelete: (id: string) => void
  onLabelChange: (id: string, label: string) => void
  onContentChange: (id: string, content: string) => void
}

function SortableAddonRow({ addon, onToggle, onDelete, onLabelChange, onContentChange }: SortableAddonRowProps) {
  const { t } = useTranslation('modals', { keyPrefix: 'personaAddons' })

  const { attributes, listeners, setNodeRef: setSortableRef, transform, transition, isDragging } = useSortable({ id: addon.id })
  const { setNodeRef, style: scaledStyle } = useScaledSortableStyle({ setNodeRef: setSortableRef, transform, transition, isDragging })
  const style = {
    ...scaledStyle,
    opacity: isDragging ? 0.6 : undefined,
    zIndex: isDragging ? 1 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={clsx(styles.addonCard, !addon.enabled && styles.addonCardDisabled)}
    >
      <div className={styles.addonTopRow}>
        <button
          type="button"
          className={styles.addonDragHandle}
          title={t('dragTitle')}
          aria-label={t('dragAria')}
          tabIndex={-1}
          onContextMenu={(e) => e.preventDefault()}
          {...attributes}
          {...listeners}
        >
          <GripVertical size={13} />
        </button>
        <button
          type="button"
          className={clsx(styles.addonToggle, addon.enabled && styles.addonToggleActive)}
          onClick={() => onToggle(addon.id)}
          title={addon.enabled ? t('disableAddon') : t('enableAddon')}
        >
          <Check size={13} />
        </button>
        <input
          type="text"
          className={styles.addonLabelInput}
          value={addon.label}
          onChange={(e) => onLabelChange(addon.id, e.target.value)}
          placeholder={t('namePlaceholder')}
        />
        <button
          type="button"
          className={styles.addonDeleteBtn}
          onClick={() => onDelete(addon.id)}
          title={t('deleteTitle')}
        >
          <Trash2 size={13} />
        </button>
      </div>
      <ExpandableTextarea
        className={styles.addonContent}
        value={addon.content}
        onChange={(v) => onContentChange(addon.id, v)}
        title={addon.label || t('addonContent')}
        placeholder={t('contentPlaceholder')}
        rows={2}
      />
    </div>
  )
}
