import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { User, Crown, Copy, Trash2, Play, Upload, Pencil, MessagesSquare, Link } from 'lucide-react'
import { ExpandableTextarea } from '@/components/shared/ExpandedTextEditor'
import { personasApi } from '@/api/personas'
import { worldBooksApi } from '@/api/world-books'
import { chatsApi } from '@/api/chats'
import { useStore } from '@/store'
import useImageCropFlow from '@/hooks/useImageCropFlow'
import ImageCropModal from '@/components/shared/ImageCropModal'
import LazyImage from '@/components/shared/LazyImage'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import NumberStepper from '@/components/shared/NumberStepper'
import type { Persona, WorldBook } from '@/types/api'
import styles from './PersonaEditor.module.css'
import clsx from 'clsx'

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
  onUploadAvatar: (id: string, file: File) => Promise<any>
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
  const [folder, setFolder] = useState(persona.folder || '')
  const [descPosition, setDescPosition] = useState<number>(persona.metadata?.description_position ?? 0)
  const [descDepth, setDescDepth] = useState<number>(persona.metadata?.description_depth ?? 4)
  const [descRole, setDescRole] = useState<string>(persona.metadata?.description_role ?? 'system')
  const openModal = useStore((s) => s.openModal)
  const activeChatId = useStore((s) => s.activeChatId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const characters = useStore((s) => s.characters)
  const characterPersonaBindings = useStore((s) => s.characterPersonaBindings)
  const setCharacterPersonaBinding = useStore((s) => s.setCharacterPersonaBinding)
  const messages = useStore((s) => s.messages)
  const setMessages = useStore((s) => s.setMessages)
  const allPersonas = useStore((s) => s.personas)
  const [worldBooks, setWorldBooks] = useState<WorldBook[]>([])
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showReattributeConfirm, setShowReattributeConfirm] = useState(false)
  const [reattributing, setReattributing] = useState(false)
  const [avatarKey, setAvatarKey] = useState(0)
  const nameTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const titleTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const descTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const folderTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const fileRef = useRef<HTMLInputElement>(null)
  const lastSyncedId = useRef<string | null>(null)

  // Collect unique folder names for datalist suggestions
  const existingFolders = useMemo(() => {
    const set = new Set<string>()
    allPersonas.forEach((p) => { if (p.folder) set.add(p.folder) })
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [allPersonas])

  // Sync from prop changes — only when switching to a different persona,
  // not when our own save updates the store (which would overwrite in-progress edits)
  useEffect(() => {
    if (lastSyncedId.current === persona.id) return
    lastSyncedId.current = persona.id
    setName(persona.name)
    setTitle(persona.title || '')
    setDescription(persona.description)
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

  // Debounced folder save
  const handleFolderChange = useCallback(
    (value: string) => {
      setFolder(value)
      clearTimeout(folderTimer.current)
      folderTimer.current = setTimeout(() => {
        onUpdate(persona.id, { folder: value })
      }, 400)
    },
    [persona.id, onUpdate]
  )

  const handleLorebookChange = useCallback(
    (value: string) => {
      onSetLorebook(persona.id, value || null)
    },
    [persona.id, onSetLorebook]
  )

  // Avatar crop flow
  const handleCropComplete = useCallback(
    async (file: File) => {
      await onUploadAvatar(persona.id, file)
      setAvatarKey((k) => k + 1)
    },
    [persona.id, onUploadAvatar]
  )

  const { cropModalProps, openCropFlow } = useImageCropFlow(handleCropComplete)

  const handleAvatarClick = useCallback(() => {
    fileRef.current?.click()
  }, [])

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
      const file = e.dataTransfer.files?.[0]
      if (file && file.type.startsWith('image/')) openCropFlow(file)
    },
    [openCropFlow]
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
  const isBoundToActiveChar = activeCharacterId ? characterPersonaBindings[activeCharacterId] === persona.id : false

  const handleToggleCharacterBinding = useCallback(() => {
    if (!activeCharacterId) return
    setCharacterPersonaBinding(activeCharacterId, isBoundToActiveChar ? null : persona.id)
  }, [activeCharacterId, isBoundToActiveChar, persona.id, setCharacterPersonaBinding])

  return (
    <div className={styles.editor}>
      {/* Avatar zone */}
      <div className={styles.topRow}>
        <div
          className={styles.avatarZone}
          onClick={handleAvatarClick}
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          title="Click or drop to change avatar"
        >
          <LazyImage
            key={avatarKey}
            src={personasApi.avatarUrl(persona.id)}
            alt={persona.name}
            className={styles.avatarImg}
            fallback={
              <div className={styles.avatarFallback}>
                <User size={24} />
              </div>
            }
          />
          <div className={styles.avatarOverlay}>
            <Upload size={16} />
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

      {/* Folder */}
      <div className={styles.folderRow}>
        <input
          type="text"
          className={styles.folderInput}
          value={folder}
          onChange={(e) => handleFolderChange(e.target.value)}
          placeholder="Folder"
          list="persona-folders"
        />
        <datalist id="persona-folders">
          {existingFolders.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
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
          <select
            className={styles.lorebookSelect}
            value={persona.attached_world_book_id || ''}
            onChange={(e) => handleLorebookChange(e.target.value)}
          >
            <option value="">No lorebook</option>
            {worldBooks.map((wb) => (
              <option key={wb.id} value={wb.id}>
                {wb.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={() =>
              openModal('worldBookEditor', {
                bookId: persona.attached_world_book_id || undefined,
              })
            }
            title="Edit world books"
          >
            <Pencil size={12} />
          </button>
        </div>
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
                : `Bind to ${activeCharName || 'character'} — auto-switch to this persona when chatting with them`
            }
          >
            <Link size={11} />
          </button>
          <span className={clsx(styles.bindingLabel, isBoundToActiveChar && styles.bindingLabelActive)}>
            {isBoundToActiveChar ? `Bound to ${activeCharName}` : `Bind to ${activeCharName}`}
          </span>
        </div>
      )}

      {/* Action buttons */}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primaryBtn}
          onClick={() => onSwitchTo(persona.id)}
        >
          <Play size={13} />
          <span>{isActive ? 'Deactivate' : 'Switch To'}</span>
        </button>
        <button
          type="button"
          className={styles.chatApplyBtn}
          onClick={() => setShowReattributeConfirm(true)}
          disabled={!activeChatId || reattributing}
          title={activeChatId ? 'Re-attribute all user messages in this chat to this persona' : 'Open a chat first'}
        >
          <MessagesSquare size={13} />
          <span>{reattributing ? 'Applying...' : 'Apply to Chat'}</span>
        </button>
        <button
          type="button"
          className={styles.actionBtn}
          onClick={() => onDuplicate(persona.id)}
          title="Duplicate"
        >
          <Copy size={13} />
        </button>
        <button
          type="button"
          className={clsx(styles.actionBtn, styles.deleteBtn)}
          onClick={() => setShowDeleteConfirm(true)}
          title="Delete"
        >
          <Trash2 size={13} />
        </button>
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
