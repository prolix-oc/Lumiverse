import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { User, Crown, Copy, Trash2, Play, Upload, Pencil, MessagesSquare, Link, Globe, RefreshCw, X } from 'lucide-react'
import { IconPlaylistAdd } from '@tabler/icons-react'
import { ExpandableTextarea } from '@/components/shared/ExpandedTextEditor'
import { getPersonaAvatarLargeUrl } from '@/lib/avatarUrls'
import { worldBooksApi } from '@/api/world-books'
import { chatsApi } from '@/api/chats'
import { charactersApi } from '@/api/characters'
import { useStore } from '@/store'
import useImageCropFlow from '@/hooks/useImageCropFlow'
import ImageCropModal from '@/components/shared/ImageCropModal'
import LazyImage from '@/components/shared/LazyImage'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { Spinner } from '@/components/shared/Spinner'
import { Button } from '@/components/shared/FormComponents'
import FolderDropdown from '@/components/shared/FolderDropdown'
import SearchableSelect from '@/components/shared/SearchableSelect'
import NumberStepper from '@/components/shared/NumberStepper'
import { useFolders } from '@/hooks/useFolders'
import { filterWorldBooksForChatContextAttachment } from '@/lib/worldBookIndexPrompt'
import {
  characterMatchesPersonaTagBinding,
  getMatchingPersonaTagBindingIds,
  resolveBinding,
  resolvePersonaTagBinding,
} from '@/store/slices/personas'
import type { Persona, TagCount, WorldBook } from '@/types/api'
import styles from './PersonaEditor.module.css'
import clsx from 'clsx'

type PronounField = 'subjective_pronoun' | 'objective_pronoun' | 'possessive_pronoun'

const PRONOUN_FIELDS: Array<{
  key: PronounField
  label: string
  macro: '{{sub}}' | '{{obj}}' | '{{poss}}'
  placeholder: string
}> = [
  { key: 'subjective_pronoun', label: 'Subjective', macro: '{{sub}}', placeholder: 'she' },
  { key: 'objective_pronoun', label: 'Objective', macro: '{{obj}}', placeholder: 'her' },
  { key: 'possessive_pronoun', label: 'Possessive', macro: '{{poss}}', placeholder: 'her' },
]

const POSITION_OPTIONS = [
  { value: 0, label: 'In Prompt' },
  { value: 1, label: 'Top AN' },
  { value: 2, label: 'Bottom AN' },
  { value: 4, label: 'At Depth' },
  { value: 99, label: 'Disabled' },
]

const ROLE_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'user', label: 'User' },
  { value: 'assistant', label: 'Assistant' },
]

interface PersonaEditorProps {
  persona: Persona
  isActive: boolean
  onUpdate: (id: string, input: Record<string, any>) => Promise<any>
  onDelete: (id: string) => Promise<void>
  onDuplicate: (id: string) => Promise<any>
  onUploadAvatar: (id: string, croppedFile: File, originalFile?: File) => Promise<any>
  onToggleDefault: (id: string) => Promise<void>
  onSetLorebook: (id: string, worldBookId: string | null) => Promise<void>
  onSwitchTo: (id: string) => void
}

export default function PersonaEditor({
  persona,
  isActive,
  onUpdate,
  onDelete,
  onDuplicate,
  onUploadAvatar,
  onToggleDefault,
  onSetLorebook,
  onSwitchTo,
}: PersonaEditorProps) {
  const [name, setName] = useState(persona.name)
  const [title, setTitle] = useState(persona.title || '')
  const [description, setDescription] = useState(persona.description)
  const [subjectivePronoun, setSubjectivePronoun] = useState(persona.subjective_pronoun || '')
  const [objectivePronoun, setObjectivePronoun] = useState(persona.objective_pronoun || '')
  const [possessivePronoun, setPossessivePronoun] = useState(persona.possessive_pronoun || '')
  const [folder, setFolder] = useState(persona.folder || '')
  const [descPosition, setDescPosition] = useState<number>(persona.metadata?.description_position ?? 0)
  const [descDepth, setDescDepth] = useState<number>(persona.metadata?.description_depth ?? 4)
  const [descRole, setDescRole] = useState<string>(persona.metadata?.description_role ?? 'system')
  const openModal = useStore((s) => s.openModal)
  const activeChatId = useStore((s) => s.activeChatId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const characters = useStore((s) => s.characters)
  const characterPersonaBindings = useStore((s) => s.characterPersonaBindings)
  const personaTagBindings = useStore((s) => s.personaTagBindings)
  const setCharacterPersonaBinding = useStore((s) => s.setCharacterPersonaBinding)
  const setPersonaTagBinding = useStore((s) => s.setPersonaTagBinding)
  const messages = useStore((s) => s.messages)
  const setMessages = useStore((s) => s.setMessages)
  const allPersonas = useStore((s) => s.personas)
  const [worldBooks, setWorldBooks] = useState<WorldBook[]>([])
  const [availableTags, setAvailableTags] = useState<TagCount[]>([])
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showReattributeConfirm, setShowReattributeConfirm] = useState(false)
  const [reattributing, setReattributing] = useState(false)
  const [avatarKey, setAvatarKey] = useState(0)
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const nameTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const titleTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const descTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const pronounTimers = useRef<Partial<Record<PronounField, ReturnType<typeof setTimeout>>>>({})
  const fileRef = useRef<HTMLInputElement>(null)
  const lastSyncedId = useRef<string | null>(null)

  const { folders: existingFolders, createFolder } = useFolders('personaFolders', allPersonas)

  // Sync from prop changes — only when switching to a different persona,
  // not when our own save updates the store (which would overwrite in-progress edits)
  useEffect(() => {
    if (lastSyncedId.current === persona.id) return
    lastSyncedId.current = persona.id
    setName(persona.name)
    setTitle(persona.title || '')
    setDescription(persona.description)
    setSubjectivePronoun(persona.subjective_pronoun || '')
    setObjectivePronoun(persona.objective_pronoun || '')
    setPossessivePronoun(persona.possessive_pronoun || '')
    setFolder(persona.folder || '')
    setDescPosition(persona.metadata?.description_position ?? 0)
    setDescDepth(persona.metadata?.description_depth ?? 4)
    setDescRole(persona.metadata?.description_role ?? 'system')
  }, [persona])

  // Load world books for dropdown
  useEffect(() => {
    worldBooksApi
      .list({ limit: 200 })
      .then((res) => setWorldBooks(res.data))
      .catch(() => {})
  }, [])

  useEffect(() => {
    charactersApi.listTags().then(setAvailableTags).catch(() => {})
  }, [])

  // Debounced name save
  const handleNameChange = useCallback(
    (value: string) => {
      setName(value)
      clearTimeout(nameTimer.current)
      nameTimer.current = setTimeout(() => {
        if (value.trim()) onUpdate(persona.id, { name: value.trim() })
      }, 400)
    },
    [persona.id, onUpdate]
  )

  // Debounced title save
  const handleTitleChange = useCallback(
    (value: string) => {
      setTitle(value)
      clearTimeout(titleTimer.current)
      titleTimer.current = setTimeout(() => {
        onUpdate(persona.id, { title: value })
      }, 400)
    },
    [persona.id, onUpdate]
  )

  // Debounced description save
  const handleDescriptionChange = useCallback(
    (value: string) => {
      setDescription(value)
      clearTimeout(descTimer.current)
      descTimer.current = setTimeout(() => {
        onUpdate(persona.id, { description: value })
      }, 400)
    },
    [persona.id, onUpdate]
  )

  const handlePronounChange = useCallback(
    (field: PronounField, value: string) => {
      if (field === 'subjective_pronoun') setSubjectivePronoun(value)
      if (field === 'objective_pronoun') setObjectivePronoun(value)
      if (field === 'possessive_pronoun') setPossessivePronoun(value)

      clearTimeout(pronounTimers.current[field])
      pronounTimers.current[field] = setTimeout(() => {
        onUpdate(persona.id, { [field]: value })
      }, 400)
    },
    [persona.id, onUpdate]
  )

  const handlePositionChange = useCallback(
    (value: number) => {
      setDescPosition(value)
      onUpdate(persona.id, {
        metadata: { ...persona.metadata, description_position: value },
      })
    },
    [persona, onUpdate]
  )

  const handleDepthChange = useCallback(
    (value: number) => {
      setDescDepth(value)
      onUpdate(persona.id, {
        metadata: { ...persona.metadata, description_depth: value },
      })
    },
    [persona, onUpdate]
  )

  const handleRoleChange = useCallback(
    (value: string) => {
      setDescRole(value)
      onUpdate(persona.id, {
        metadata: { ...persona.metadata, description_role: value },
      })
    },
    [persona, onUpdate]
  )

  const handleFolderChange = useCallback(
    (value: string) => {
      setFolder(value)
      onUpdate(persona.id, { folder: value })
    },
    [persona.id, onUpdate]
  )

  const handleLorebookChange = useCallback(
    async (value: string) => {
      const nextId = value || null
      if (!nextId || !activeChatId || !isActive) {
        await onSetLorebook(persona.id, nextId)
        return
      }

      const approvedIds = await filterWorldBooksForChatContextAttachment(
        worldBooks.filter((book) => book.id === nextId),
      )
      await onSetLorebook(persona.id, approvedIds[0] || null)
    },
    [activeChatId, isActive, onSetLorebook, persona.id, worldBooks]
  )

  // Avatar crop flow — upload both cropped (for avatar display) and original (for full viewing)
  const handleCropComplete = useCallback(
    async (croppedFile: File, originalFile: File) => {
      setUploadingAvatar(true)
      try {
        await onUploadAvatar(persona.id, croppedFile, originalFile)
        setAvatarKey((k) => k + 1)
      } finally {
        setUploadingAvatar(false)
      }
    },
    [persona.id, onUploadAvatar]
  )

  const { cropModalProps, openCropFlow } = useImageCropFlow(handleCropComplete)

  const handleAvatarClick = useCallback(() => {
    if (uploadingAvatar) return
    fileRef.current?.click()
  }, [uploadingAvatar])

  const handleFileSelected = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) openCropFlow(file)
      e.target.value = ''
    },
    [openCropFlow]
  )

  // Drag-drop avatar
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      if (uploadingAvatar) return
      const file = e.dataTransfer.files?.[0]
      if (file && file.type.startsWith('image/')) openCropFlow(file)
    },
    [openCropFlow, uploadingAvatar]
  )

  const handleReattributeChat = useCallback(async () => {
    if (!activeChatId || reattributing) return
    setReattributing(true)
    try {
      await chatsApi.reattributeUserMessages(activeChatId, persona.id)
      const patched = messages.map((m) =>
        m.is_user
          ? { ...m, name: persona.name, extra: { ...(m.extra || {}), persona_id: persona.id } }
          : m
      )
      setMessages(patched)
      setShowReattributeConfirm(false)
    } catch (err) {
      console.error('[PersonaEditor] Failed to re-attribute chat messages:', err)
    } finally {
      setReattributing(false)
    }
  }, [activeChatId, reattributing, persona.id, persona.name, messages, setMessages])

  // Character-persona binding
  const activeCharName = activeCharacterId ? characters.find((c) => c.id === activeCharacterId)?.name : null
  const activeCharacter = activeCharacterId ? characters.find((c) => c.id === activeCharacterId) ?? null : null
  const activeCharacterTags = activeCharacter?.tags ?? []
  const rawBinding = activeCharacterId ? characterPersonaBindings[activeCharacterId] : undefined
  const boundPersonaId = rawBinding ? resolveBinding(rawBinding).personaId : undefined
  const isBoundToActiveChar = boundPersonaId === persona.id
  const boundAddonStates = isBoundToActiveChar && rawBinding ? resolveBinding(rawBinding).addonStates : undefined
  const tagBinding = resolvePersonaTagBinding(personaTagBindings[persona.id])
  const tagBindingTagCount = tagBinding?.tags.length ?? 0
  const tagBindingHasAddonStates = !!tagBinding?.addonStates && Object.keys(tagBinding.addonStates).length > 0
  const personaAddonCount = Array.isArray(persona.metadata?.addons) ? persona.metadata.addons.length : 0
  const globalAddonCount = Array.isArray(persona.metadata?.attached_global_addons) ? persona.metadata.attached_global_addons.length : 0
  const addonCount = personaAddonCount + globalAddonCount
  const tagOptions = useMemo(
    () => availableTags.map(({ tag, count }) => ({ value: tag, label: tag, sublabel: `${count} character${count === 1 ? '' : 's'}` })),
    [availableTags],
  )
  const matchingCharacterCount = useMemo(
    () => tagBinding ? characters.filter((character) => characterMatchesPersonaTagBinding(character.tags || [], tagBinding)).length : 0,
    [characters, tagBinding],
  )
  const matchingActivePersonaIds = useMemo(
    () => activeCharacter ? getMatchingPersonaTagBindingIds(allPersonas, personaTagBindings, activeCharacter.tags || []) : [],
    [activeCharacter, allPersonas, personaTagBindings],
  )
  const matchesActiveCharacterByTag = activeCharacter ? characterMatchesPersonaTagBinding(activeCharacterTags, tagBinding) : false
  const activeCharacterConflictCount = matchesActiveCharacterByTag
    ? matchingActivePersonaIds.filter((personaId) => personaId !== persona.id).length
    : 0
  const activeCharacterTagSuggestions = useMemo(() => {
    if (!activeCharacter) return []
    const selected = new Set((tagBinding?.tags ?? []).map((tag) => tag.trim().toLowerCase()))
    return activeCharacter.tags.filter((tag) => !selected.has(tag.trim().toLowerCase())).slice(0, 8)
  }, [activeCharacter, tagBinding])

  /** Build a snapshot of current addon enabled states. */
  const snapshotAddonStates = useCallback((): Record<string, boolean> => {
    const states: Record<string, boolean> = {}
    const addons = persona.metadata?.addons
    if (Array.isArray(addons)) {
      for (const a of addons) states[a.id] = a.enabled
    }
    const globalRefs = persona.metadata?.attached_global_addons
    if (Array.isArray(globalRefs)) {
      for (const r of globalRefs) states[r.id] = r.enabled
    }
    return states
  }, [persona.metadata])

  const handleToggleCharacterBinding = useCallback(() => {
    if (!activeCharacterId) return
    if (isBoundToActiveChar) {
      setCharacterPersonaBinding(activeCharacterId, null)
    } else {
      setCharacterPersonaBinding(activeCharacterId, persona.id, snapshotAddonStates())
    }
  }, [activeCharacterId, isBoundToActiveChar, persona.id, snapshotAddonStates, setCharacterPersonaBinding])

  const handleRebindAddons = useCallback(() => {
    if (!activeCharacterId || !isBoundToActiveChar) return
    setCharacterPersonaBinding(activeCharacterId, persona.id, snapshotAddonStates())
  }, [activeCharacterId, isBoundToActiveChar, persona.id, snapshotAddonStates, setCharacterPersonaBinding])

  const handleTagBindingTagsChange = useCallback((tags: string[]) => {
    const current = resolvePersonaTagBinding(useStore.getState().personaTagBindings[persona.id])
    setPersonaTagBinding(persona.id, tags.length > 0
      ? { tags, mode: current?.mode ?? 'any', addonStates: current?.addonStates }
      : null)
  }, [persona.id, setPersonaTagBinding])

  const handleTagBindingModeChange = useCallback((value: string) => {
    const current = resolvePersonaTagBinding(useStore.getState().personaTagBindings[persona.id])
    if (!current) return
    setPersonaTagBinding(persona.id, { ...current, mode: value === 'all' ? 'all' : 'any' })
  }, [persona.id, setPersonaTagBinding])

  const handleClearTagBinding = useCallback(() => {
    setPersonaTagBinding(persona.id, null)
  }, [persona.id, setPersonaTagBinding])

  const handleSnapshotTagBindingAddons = useCallback(() => {
    const current = resolvePersonaTagBinding(useStore.getState().personaTagBindings[persona.id])
    if (!current) return
    setPersonaTagBinding(persona.id, { ...current, addonStates: snapshotAddonStates() })
  }, [persona.id, setPersonaTagBinding, snapshotAddonStates])

  const handleRemoveTagBindingTag = useCallback((tagToRemove: string) => {
    const current = resolvePersonaTagBinding(useStore.getState().personaTagBindings[persona.id])
    if (!current) return
    const nextTags = current.tags.filter((tag) => tag !== tagToRemove)
    setPersonaTagBinding(persona.id, nextTags.length > 0 ? { ...current, tags: nextTags } : null)
  }, [persona.id, setPersonaTagBinding])

  const handleAddSuggestedTag = useCallback((tag: string) => {
    const current = resolvePersonaTagBinding(useStore.getState().personaTagBindings[persona.id])
    const nextTags = current?.tags ?? []
    if (nextTags.some((candidate) => candidate.trim().toLowerCase() === tag.trim().toLowerCase())) return
    setPersonaTagBinding(persona.id, {
      tags: [...nextTags, tag],
      mode: current?.mode ?? 'any',
      addonStates: current?.addonStates,
    })
  }, [persona.id, setPersonaTagBinding])

  return (
    <div className={styles.editor}>
      {/* Avatar zone */}
      <div className={styles.topRow}>
        <div
          className={clsx(styles.avatarZone, uploadingAvatar && styles.avatarZoneUploading)}
          onClick={handleAvatarClick}
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          title={uploadingAvatar ? 'Uploading avatar...' : 'Click or drop to change avatar'}
          aria-busy={uploadingAvatar}
        >
          <LazyImage
            key={avatarKey}
            src={getPersonaAvatarLargeUrl(persona) || ''}
            alt={persona.name}
            className={styles.avatarImg}
            fallback={
              <div className={styles.avatarFallback}>
                <User size={24} />
              </div>
            }
          />
          <div className={clsx(styles.avatarOverlay, uploadingAvatar && styles.avatarOverlayActive)}>
            {uploadingAvatar ? <Spinner size={20} /> : <Upload size={16} />}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className={styles.hiddenInput}
            onChange={handleFileSelected}
          />
        </div>

        <div className={styles.nameGroup}>
          {/* Name input */}
          <input
            type="text"
            className={styles.nameInput}
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="Persona name"
          />
          {/* Title input */}
          <input
            type="text"
            className={styles.titleInput}
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            placeholder="Short title / tagline"
          />
        </div>
      </div>

      {/* Description */}
      <div className={styles.section}>
        <ExpandableTextarea
          className={styles.descTextarea}
          value={description}
          onChange={handleDescriptionChange}
          title={`${persona.name} — Description`}
          placeholder="Persona description..."
          rows={4}
        />
        <div className={styles.descControls}>
          <select
            className={styles.select}
            value={descPosition}
            onChange={(e) => handlePositionChange(Number(e.target.value))}
          >
            {POSITION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {descPosition === 4 && (
            <NumberStepper
              value={descDepth}
              onChange={(v) => handleDepthChange(v ?? 0)}
              min={0}
              className={styles.depthInput}
            />
          )}
          <select
            className={styles.select}
            value={descRole}
            onChange={(e) => handleRoleChange(e.target.value)}
          >
            {ROLE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className={styles.pronounSection}>
        <div className={styles.pronounHeader}>
          <span className={styles.pronounTitle}>Pronouns</span>
          <span className={styles.pronounHint}>Used by JanitorAI persona macros</span>
        </div>
        <div className={styles.pronounGrid}>
          {PRONOUN_FIELDS.map((field) => {
            const value =
              field.key === 'subjective_pronoun'
                ? subjectivePronoun
                : field.key === 'objective_pronoun'
                  ? objectivePronoun
                  : possessivePronoun

            return (
              <label key={field.key} className={styles.pronounField}>
                <span className={styles.pronounLabel}>{field.label}</span>
                <div className={styles.pronounInputWrap}>
                  <code className={styles.pronounMacro} aria-hidden="true">
                    {field.macro}
                  </code>
                  <input
                    type="text"
                    className={styles.pronounInput}
                    value={value}
                    onChange={(e) => handlePronounChange(field.key, e.target.value)}
                    placeholder={field.placeholder}
                  />
                </div>
              </label>
            )
          })}
        </div>
      </div>

      {/* Folder */}
      <div className={styles.folderRow}>
        <FolderDropdown
          folders={existingFolders}
          selectedFolder={folder}
          onSelect={handleFolderChange}
          onCreateFolder={createFolder}
        />
      </div>

      {/* Locks section */}
      <div className={styles.locksRow}>
        <button
          type="button"
          className={clsx(styles.toggleBtn, persona.is_default && styles.toggleBtnActive)}
          onClick={() => onToggleDefault(persona.id)}
          title={persona.is_default ? 'Remove default' : 'Set as default'}
        >
          <Crown size={13} />
          <span>Default</span>
        </button>
        <div className={styles.lorebookRow}>
          <SearchableSelect
            value={persona.attached_world_book_id || ''}
            onChange={(value) => { void handleLorebookChange(value) }}
            options={worldBooks.map((wb) => ({ value: wb.id, label: wb.name, group: wb.folder || undefined }))}
            placeholder="No lorebook"
            searchPlaceholder="Search world books…"
            emptyMessage="No world books available"
            clearable
            clearLabel="No lorebook"
            className={styles.lorebookSelectWrapper}
          />
          <Button
            size="icon-sm" variant="ghost"
            onClick={() =>
              openModal('worldBookEditor', {
                bookId: persona.attached_world_book_id || undefined,
              })
            }
            title="Edit world books"
            icon={<Pencil size={12} />}
          />
        </div>
      </div>

      {/* Add-Ons */}
      <div className={styles.locksRow}>
        <button
          type="button"
          className={clsx(styles.toggleBtn, addonCount > 0 && styles.addonsBtn)}
          onClick={() => openModal('personaAddons', { personaId: persona.id, personaName: persona.name })}
          title="Manage persona add-ons"
        >
          <IconPlaylistAdd size={13} />
          <span>Add-Ons{addonCount > 0 ? ` (${addonCount})` : ''}</span>
        </button>
        <button
          type="button"
          className={styles.toggleBtn}
          onClick={() => openModal('globalAddonsLibrary')}
          title="Global add-ons library"
        >
          <Globe size={13} />
          <span>Global Library</span>
        </button>
      </div>

      {/* Character binding indicator */}
      {activeCharacterId && (
        <div className={styles.bindingRow}>
          <button
            type="button"
            className={clsx(styles.bindingToggle, isBoundToActiveChar && styles.bindingToggleActive)}
            onClick={handleToggleCharacterBinding}
            title={
              isBoundToActiveChar
                ? `Unbind from ${activeCharName || 'character'}`
                : `Bind to ${activeCharName || 'character'} — auto-switch to this persona and add-on states when chatting with them`
            }
          >
            <Link size={11} />
          </button>
          <span className={clsx(styles.bindingLabel, isBoundToActiveChar && styles.bindingLabelActive)}>
            {isBoundToActiveChar ? `Bound to ${activeCharName}` : `Bind to ${activeCharName}`}
          </span>
          {isBoundToActiveChar && addonCount > 0 && (
            <button
              type="button"
              className={styles.rebindBtn}
              onClick={handleRebindAddons}
              title={`Rebind add-on states to ${activeCharName || 'character'} — snapshot current enabled/disabled states`}
            >
              <RefreshCw size={10} />
              <span>{boundAddonStates ? 'Rebind' : 'Bind'} Add-Ons</span>
            </button>
          )}
        </div>
      )}

      <div className={styles.tagBindingSection}>
        <div className={styles.tagBindingHeader}>
          <span className={styles.tagBindingTitle}>Tag Auto-Bind</span>
          <span className={styles.tagBindingHint}>
            Exact character bindings override these rules. Any/All only differs once 2+ tags are selected.
          </span>
        </div>
        <div className={styles.tagBindingControls}>
          <SearchableSelect
            multi
            value={tagBinding?.tags ?? []}
            onChange={handleTagBindingTagsChange}
            options={tagOptions}
            placeholder="Choose character tags"
            searchPlaceholder="Search character tags…"
            emptyMessage="No character tags found"
            noResultsMessage="No matching tags"
            className={styles.tagBindingSelect}
            portal
          />
          <select
            className={clsx(styles.select, styles.tagModeSelect)}
            value={tagBinding?.mode ?? 'any'}
            onChange={(e) => handleTagBindingModeChange(e.target.value)}
            disabled={!tagBinding || tagBindingTagCount < 2}
            title={tagBindingTagCount < 2 ? 'Choose at least two tags to use Any vs All matching.' : undefined}
          >
            <option value="any">Any tag</option>
            <option value="all">All tags</option>
          </select>
          {tagBinding && addonCount > 0 && (
            <button
              type="button"
              className={styles.rebindBtn}
              onClick={handleSnapshotTagBindingAddons}
              title="Snapshot current add-on states into this tag binding"
            >
              <RefreshCw size={10} />
              <span>{tagBindingHasAddonStates ? 'Rebind' : 'Bind'} Add-Ons</span>
            </button>
          )}
          {tagBinding && (
            <button
              type="button"
              className={styles.clearBindingBtn}
              onClick={handleClearTagBinding}
              title="Remove tag auto-bind"
            >
              Clear
            </button>
          )}
        </div>

        {tagBinding?.tags.length ? (
          <div className={styles.tagChipList}>
            {tagBinding.tags.map((tag) => (
              <span key={tag} className={styles.tagChip}>
                {tag}
                <button
                  type="button"
                  className={styles.tagChipRemove}
                  onClick={() => handleRemoveTagBindingTag(tag)}
                  title={`Remove ${tag}`}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {activeCharacterTagSuggestions.length > 0 && (
          <div className={styles.tagSuggestionRow}>
            <span className={styles.tagSuggestionLabel}>Add from {activeCharName || 'active character'}:</span>
            <div className={styles.tagSuggestionList}>
              {activeCharacterTagSuggestions.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className={styles.tagSuggestionBtn}
                  onClick={() => handleAddSuggestedTag(tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className={styles.tagBindingMeta}>
          {tagBinding
            ? <span>Matches {matchingCharacterCount} character{matchingCharacterCount === 1 ? '' : 's'}.</span>
            : <span>Select tags to auto-switch this persona for matching characters.</span>}
          {activeCharacter && tagBinding && (
            <span>
              {matchesActiveCharacterByTag
                ? activeCharacterConflictCount > 0
                  ? `${activeCharName || 'Active character'} matches, but ${activeCharacterConflictCount} other persona${activeCharacterConflictCount === 1 ? '' : 's'} also match.`
                  : `${activeCharName || 'Active character'} matches this rule.`
                : `${activeCharName || 'Active character'} does not match this rule.`}
            </span>
          )}
          {activeCharacter && tagBinding && rawBinding && boundPersonaId !== persona.id && matchesActiveCharacterByTag && (
            <span>Current chat still prefers its exact character binding.</span>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className={styles.actions}>
        <Button
          variant="primary" size="sm"
          icon={<Play size={13} />}
          onClick={() => onSwitchTo(persona.id)}
        >
          {isActive ? 'Deactivate' : 'Switch To'}
        </Button>
        <Button
          variant="secondary" size="sm"
          icon={<MessagesSquare size={13} />}
          onClick={() => setShowReattributeConfirm(true)}
          disabled={!activeChatId || reattributing}
          title={activeChatId ? 'Re-attribute all user messages in this chat to this persona' : 'Open a chat first'}
        >
          {reattributing ? 'Applying...' : 'Apply to Chat'}
        </Button>
        <Button
          size="icon-sm" variant="ghost"
          onClick={() => onDuplicate(persona.id)}
          title="Duplicate"
          icon={<Copy size={13} />}
        />
        <Button
          size="icon-sm" variant="danger-ghost"
          onClick={() => setShowDeleteConfirm(true)}
          title="Delete"
          icon={<Trash2 size={13} />}
        />
      </div>

      <ImageCropModal {...cropModalProps} />

      {showDeleteConfirm && (
        <ConfirmationModal
          title="Delete Persona"
          message={`Delete "${persona.name}"? This cannot be undone.`}
          isOpen={true}
          variant="danger"
          confirmText="Delete"
          onConfirm={async () => {
            await onDelete(persona.id)
            setShowDeleteConfirm(false)
          }}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {showReattributeConfirm && (
        <ConfirmationModal
          title="Apply Persona to Chat"
          message={`Rename all user messages in the active chat to "${persona.name}"?`}
          isOpen={true}
          confirmText="Apply"
          onConfirm={handleReattributeChat}
          onCancel={() => setShowReattributeConfirm(false)}
        />
      )}
    </div>
  )
}
