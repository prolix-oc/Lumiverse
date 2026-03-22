import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { X, Upload, Trash2, Copy, MessageSquare, User, Plus, BookOpen, ImagePlus, Download } from 'lucide-react'
import { ExpandableTextarea } from '@/components/shared/ExpandedTextEditor'
import { charactersApi } from '@/api/characters'
import { characterGalleryApi } from '@/api/character-gallery'
import { worldBooksApi } from '@/api/world-books'
import { useStore } from '@/store'
import { useCharacterBrowser } from '@/hooks/useCharacterBrowser'
import useImageCropFlow from '@/hooks/useImageCropFlow'
import ImageCropModal from '@/components/shared/ImageCropModal'
import LazyImage from '@/components/shared/LazyImage'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import type { Character, CharacterGalleryItem } from '@/types/api'
import styles from './CharacterEditorPage.module.css'
import clsx from 'clsx'
import ExpressionEditorTab from './ExpressionEditorTab'

const DEBOUNCE_MS = 2000

type TabId = 'core' | 'system' | 'greetings' | 'identity' | 'gallery' | 'expressions' | 'advanced'

const TABS: { id: TabId; label: string }[] = [
  { id: 'core', label: 'Core Prompts' },
  { id: 'system', label: 'System' },
  { id: 'greetings', label: 'Greetings' },
  { id: 'identity', label: 'Identity' },
  { id: 'gallery', label: 'Gallery' },
  { id: 'expressions', label: 'Expressions' },
  { id: 'advanced', label: 'Advanced' },
]

export default function CharacterEditorPage() {
  const editingCharacterId = useStore((s) => s.editingCharacterId)
  const setEditingCharacterId = useStore((s) => s.setEditingCharacterId)
  const allCharacters = useStore((s) => s.characters)
  const browser = useCharacterBrowser()

  const character = allCharacters.find((c) => c.id === editingCharacterId) ?? null
  const isOpen = !!editingCharacterId

  const [activeTab, setActiveTab] = useState<TabId>('core')
  const [name, setName] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [tags, setTags] = useState<string[]>([])
  const [newTag, setNewTag] = useState('')
  const [alternateGreetings, setAlternateGreetings] = useState<string[]>([])
  const [extensionsJson, setExtensionsJson] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [avatarKey, setAvatarKey] = useState(0)
  const [lorebookImporting, setLorebookImporting] = useState(false)
  const [lorebookResult, setLorebookResult] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [galleryItems, setGalleryItems] = useState<CharacterGalleryItem[]>([])
  const [worldBooks, setWorldBooks] = useState<Array<{ id: string; name: string }>>([])
  const [galleryUploading, setGalleryUploading] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const fileRef = useRef<HTMLInputElement>(null)
  const galleryFileRef = useRef<HTMLInputElement>(null)
  const savingTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const lastSyncedId = useRef<string | null>(null)

  const close = useCallback(() => setEditingCharacterId(null), [setEditingCharacterId])

  // Escape to close
  useEffect(() => {
    if (!isOpen) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen, close])

  // Reset tab and force re-sync when switching to a different character.
  // Keyed on editingCharacterId (a stable string) so store-driven object
  // reference changes can never accidentally reset the active tab.
  useEffect(() => {
    lastSyncedId.current = null
    if (editingCharacterId) {
      setActiveTab('core')
    }
  }, [editingCharacterId])

  // Sync form fields from character data — runs when the character object
  // changes, but the lastSyncedId guard skips redundant syncs for the same
  // character (e.g. after our own debounced save updates the store).
  useEffect(() => {
    if (!character) return
    if (lastSyncedId.current === character.id) return
    lastSyncedId.current = character.id
    setName(character.name)
    setFields({
      description: character.description || '',
      personality: character.personality || '',
      scenario: character.scenario || '',
      system_prompt: character.system_prompt || '',
      post_history_instructions: character.post_history_instructions || '',
      first_mes: character.first_mes || '',
      mes_example: character.mes_example || '',
      creator: character.creator || '',
      creator_notes: character.creator_notes || '',
    })
    setTags(character.tags || [])
    setAlternateGreetings(character.alternate_greetings || [])
    setExtensionsJson(JSON.stringify(character.extensions || {}, null, 2))
    setJsonError(null)
    setLorebookImporting(false)
    setLorebookResult(null)
  }, [character])

  const showSaving = useCallback(() => {
    setSaving(true)
    clearTimeout(savingTimer.current)
    savingTimer.current = setTimeout(() => setSaving(false), 1000)
  }, [])

  // Gallery
  const fetchGallery = useCallback(() => {
    if (!editingCharacterId) return
    characterGalleryApi.list(editingCharacterId).then(setGalleryItems).catch(() => {})
  }, [editingCharacterId])

  useEffect(() => {
    fetchGallery()
  }, [fetchGallery])

  useEffect(() => {
    let cancelled = false
    const loadWorldBooks = async () => {
      try {
        const res = await worldBooksApi.list({ limit: 200 })
        if (!cancelled) setWorldBooks(res.data.map((b) => ({ id: b.id, name: b.name })))
      } catch {
        // no-op
      }
    }
    loadWorldBooks()
    return () => {
      cancelled = true
    }
  }, [])

  const handleGalleryUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file || !editingCharacterId) return
      e.target.value = ''
      setGalleryUploading(true)
      try {
        const item = await characterGalleryApi.upload(editingCharacterId, file)
        setGalleryItems((prev) => [...prev, item])
      } catch {
        // upload failed
      } finally {
        setGalleryUploading(false)
      }
    },
    [editingCharacterId]
  )

  const handleGalleryRemove = useCallback(
    async (itemId: string) => {
      if (!editingCharacterId) return
      await characterGalleryApi.remove(editingCharacterId, itemId)
      setGalleryItems((prev) => prev.filter((i) => i.id !== itemId))
    },
    [editingCharacterId]
  )

  const handleGalleryExtract = useCallback(async () => {
    if (!editingCharacterId) return
    setExtracting(true)
    try {
      const items = await characterGalleryApi.extract(editingCharacterId)
      if (items.length > 0) setGalleryItems((prev) => [...prev, ...items])
    } catch {
      // extraction failed
    } finally {
      setExtracting(false)
    }
  }, [editingCharacterId])

  const embeddedImageCount = useMemo(() => {
    if (!character) return 0
    const MD_RE = /!\[[^\]]*\]\([^)]+\)/g
    const IMG_RE = /<img[^>]+src=["'][^"']+["']/gi
    const texts = [
      character.first_mes,
      character.description,
      character.personality,
      character.scenario,
      character.mes_example,
      character.system_prompt,
      character.post_history_instructions,
      character.creator_notes,
      ...(character.alternate_greetings || []),
      character.extensions ? JSON.stringify(character.extensions) : '',
    ]
    const seen = new Set<string>()
    for (const t of texts) {
      if (!t) continue
      for (const m of t.matchAll(MD_RE)) {
        const url = m[0].match(/\(([^)]+)\)/)?.[1]
        if (url && (url.startsWith('http') || url.startsWith('data:'))) seen.add(url)
      }
      for (const m of t.matchAll(IMG_RE)) {
        const url = m[0].match(/src=["']([^"']+)["']/)?.[1]
        if (url && (url.startsWith('http') || url.startsWith('data:'))) seen.add(url)
      }
    }
    return seen.size
  }, [character])

  const debouncedSave = useCallback(
    (field: string, value: any) => {
      if (!editingCharacterId) return
      clearTimeout(timers.current[field])
      timers.current[field] = setTimeout(() => {
        showSaving()
        browser.updateCharacter(editingCharacterId, { [field]: value })
      }, DEBOUNCE_MS)
    },
    [editingCharacterId, browser.updateCharacter, showSaving]
  )

  const handleNameChange = useCallback(
    (value: string) => {
      setName(value)
      if (value.trim()) debouncedSave('name', value.trim())
    },
    [debouncedSave]
  )

  const handleFieldChange = useCallback(
    (field: string, value: string) => {
      setFields((prev) => ({ ...prev, [field]: value }))
      debouncedSave(field, value)
    },
    [debouncedSave]
  )

  const handleAddTag = useCallback(() => {
    if (!editingCharacterId) return
    const tag = newTag.trim()
    if (!tag || tags.includes(tag)) return
    const updated = [...tags, tag]
    setTags(updated)
    setNewTag('')
    showSaving()
    browser.updateCharacter(editingCharacterId, { tags: updated })
  }, [newTag, tags, editingCharacterId, browser.updateCharacter, showSaving])

  const handleRemoveTag = useCallback(
    (tag: string) => {
      if (!editingCharacterId) return
      const updated = tags.filter((t) => t !== tag)
      setTags(updated)
      showSaving()
      browser.updateCharacter(editingCharacterId, { tags: updated })
    },
    [tags, editingCharacterId, browser.updateCharacter, showSaving]
  )

  const handleGreetingChange = useCallback(
    (index: number, value: string) => {
      const updated = [...alternateGreetings]
      updated[index] = value
      setAlternateGreetings(updated)
      debouncedSave('alternate_greetings', updated)
    },
    [alternateGreetings, debouncedSave]
  )

  const handleAddGreeting = useCallback(() => {
    const updated = [...alternateGreetings, '']
    setAlternateGreetings(updated)
    if (editingCharacterId) {
      showSaving()
      browser.updateCharacter(editingCharacterId, { alternate_greetings: updated })
    }
  }, [alternateGreetings, editingCharacterId, browser.updateCharacter, showSaving])

  const handleRemoveGreeting = useCallback(
    (index: number) => {
      const updated = alternateGreetings.filter((_, i) => i !== index)
      setAlternateGreetings(updated)
      if (editingCharacterId) {
        showSaving()
        browser.updateCharacter(editingCharacterId, { alternate_greetings: updated })
      }
    },
    [alternateGreetings, editingCharacterId, browser.updateCharacter, showSaving]
  )

  const handleExtensionsChange = useCallback(
    (value: string) => {
      setExtensionsJson(value)
      try {
        const parsed = JSON.parse(value)
        setJsonError(null)
        debouncedSave('extensions', parsed)
      } catch {
        setJsonError('Invalid JSON')
      }
    },
    [debouncedSave]
  )

  const clearActivatedWorldInfo = useStore((s) => s.clearActivatedWorldInfo)

  const handleAttachedWorldBookChange = useCallback(
    async (worldBookId: string) => {
      if (!editingCharacterId || !character) return
      const nextExtensions = {
        ...(character.extensions || {}),
      } as Record<string, any>

      if (worldBookId) nextExtensions.world_book_id = worldBookId
      else {
        delete nextExtensions.world_book_id
        // Immediately clear the feedback panel so entries don't visually linger
        clearActivatedWorldInfo()
      }

      setExtensionsJson(JSON.stringify(nextExtensions, null, 2))
      setJsonError(null)
      showSaving()
      await browser.updateCharacter(editingCharacterId, { extensions: nextExtensions })
    },
    [editingCharacterId, character, browser.updateCharacter, showSaving, clearActivatedWorldInfo]
  )

  // Avatar
  const handleCropComplete = useCallback(
    async (file: File) => {
      if (!editingCharacterId) return
      await browser.uploadAvatar(editingCharacterId, file)
      setAvatarKey((k) => k + 1)
    },
    [editingCharacterId, browser.uploadAvatar]
  )

  const { cropModalProps, openCropFlow } = useImageCropFlow(handleCropComplete)

  const handleFileSelected = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) openCropFlow(file)
      e.target.value = ''
    },
    [openCropFlow]
  )

  const handleAvatarDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const file = e.dataTransfer.files?.[0]
      if (file && file.type.startsWith('image/')) openCropFlow(file)
    },
    [openCropFlow]
  )

  // Actions
  const handleDelete = useCallback(async () => {
    if (!editingCharacterId) return
    await browser.deleteCharacter(editingCharacterId)
    close()
    setShowDeleteConfirm(false)
  }, [editingCharacterId, browser.deleteCharacter, close])

  const handleDuplicate = useCallback(async () => {
    if (!editingCharacterId) return
    const dup = await browser.duplicateCharacter(editingCharacterId)
    setEditingCharacterId(dup.id)
  }, [editingCharacterId, browser.duplicateCharacter, setEditingCharacterId])

  const handleOpenChat = useCallback(() => {
    if (!character) return
    close()
    browser.openChat(character)
  }, [character, browser.openChat, close])

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) close()
    },
    [close]
  )

  return createPortal(
    <>
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className={styles.backdrop}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={handleBackdropClick}
        >
          <motion.div
            className={styles.modal}
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          >
            {!character ? (
              <div className={styles.header}>
                <span className={styles.creatorText}>Character not found</span>
                <button type="button" className={styles.closeBtn} onClick={close}>
                  <X size={16} />
                </button>
              </div>
            ) : (
              <>
                {/* Header */}
                <div className={styles.header}>
                  <div
                    className={styles.avatarZone}
                    onClick={() => fileRef.current?.click()}
                    onDrop={handleAvatarDrop}
                    onDragOver={(e) => e.preventDefault()}
                    title="Click or drop to change avatar"
                  >
                    <LazyImage
                      key={avatarKey}
                      src={charactersApi.avatarUrl(character.id)}
                      alt={character.name}
                      className={styles.avatarImg}
                      fallback={
                        <div className={styles.avatarFallback}>
                          <User size={20} />
                        </div>
                      }
                    />
                    <div className={styles.avatarOverlay}>
                      <Upload size={14} />
                    </div>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/*"
                      className={styles.hiddenInput}
                      onChange={handleFileSelected}
                    />
                  </div>

                  <div className={styles.headerInfo}>
                    <input
                      type="text"
                      className={styles.nameInput}
                      value={name}
                      onChange={(e) => handleNameChange(e.target.value)}
                      placeholder="Character name"
                    />
                    {character.creator && <span className={styles.creatorText}>by {character.creator}</span>}
                  </div>

                  {saving && <span className={styles.savingIndicator}>Saving...</span>}

                  <div className={styles.headerActions}>
                    <button type="button" className={styles.actionBtn} onClick={handleOpenChat} title="Open Chat">
                      <MessageSquare size={14} />
                    </button>
                    <button type="button" className={styles.actionBtn} onClick={handleDuplicate} title="Duplicate">
                      <Copy size={14} />
                    </button>
                    <button
                      type="button"
                      className={clsx(styles.actionBtn, styles.deleteBtn)}
                      onClick={() => setShowDeleteConfirm(true)}
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>

                  <button type="button" className={styles.closeBtn} onClick={close} aria-label="Close">
                    <X size={16} />
                  </button>
                </div>

                {/* Tab bar */}
                <div className={styles.tabBar}>
                  {TABS.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      className={clsx(styles.tab, activeTab === tab.id && styles.tabActive)}
                      onClick={() => setActiveTab(tab.id)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* Tab content */}
                <div className={styles.tabContent}>
                  {activeTab === 'core' && (
                    <>
                      <Field
                        label="Description"
                        helper="The character's physical appearance, backstory, and other details."
                        value={fields.description || ''}
                        onChange={(v) => handleFieldChange('description', v)}
                        rows={5}
                      />
                      <Field
                        label="Personality"
                        helper="Key personality traits and behavioral patterns."
                        value={fields.personality || ''}
                        onChange={(v) => handleFieldChange('personality', v)}
                        rows={4}
                      />
                      <Field
                        label="Scenario"
                        helper="The setting or situation for the roleplay."
                        value={fields.scenario || ''}
                        onChange={(v) => handleFieldChange('scenario', v)}
                        rows={3}
                      />
                    </>
                  )}

                  {activeTab === 'system' && (
                    <>
                      <Field
                        label="System Prompt"
                        helper="Instructions injected at the start of every conversation."
                        value={fields.system_prompt || ''}
                        onChange={(v) => handleFieldChange('system_prompt', v)}
                        rows={6}
                      />
                      <Field
                        label="Post-History Instructions"
                        helper="Instructions injected after the chat history (jailbreak position)."
                        value={fields.post_history_instructions || ''}
                        onChange={(v) => handleFieldChange('post_history_instructions', v)}
                        rows={4}
                      />
                    </>
                  )}

                  {activeTab === 'greetings' && (
                    <>
                      <Field
                        label="First Message"
                        helper="The opening message the character sends when starting a new chat."
                        value={fields.first_mes || ''}
                        onChange={(v) => handleFieldChange('first_mes', v)}
                        rows={5}
                      />
                      <Field
                        label="Message Examples"
                        helper="Example dialogues showing how the character speaks (use <START> to separate)."
                        value={fields.mes_example || ''}
                        onChange={(v) => handleFieldChange('mes_example', v)}
                        rows={5}
                      />
                      <div className={styles.fieldGroup}>
                        <span className={styles.fieldLabel}>Alternate Greetings</span>
                        <span className={styles.fieldHelper}>
                          Alternative first messages that can be randomly selected.
                        </span>
                        {alternateGreetings.map((greeting, i) => (
                          <div key={i} className={styles.greetingItem}>
                            <div className={styles.greetingHeader}>
                              <span className={styles.greetingLabel}>Greeting #{i + 1}</span>
                              <button
                                type="button"
                                className={styles.removeBtn}
                                onClick={() => handleRemoveGreeting(i)}
                                title="Remove"
                              >
                                <X size={12} />
                              </button>
                            </div>
                            <ExpandableTextarea
                              className={styles.fieldTextarea}
                              value={greeting}
                              onChange={(v) => handleGreetingChange(i, v)}
                              rows={3}
                              title={`Greeting #${i + 1}`}
                              placeholder="Alternate greeting..."
                            />
                          </div>
                        ))}
                        <button type="button" className={styles.addBtn} onClick={handleAddGreeting}>
                          <Plus size={12} /> Add Greeting
                        </button>
                      </div>
                    </>
                  )}

                  {activeTab === 'identity' && (
                    <>
                      <Field
                        label="Creator"
                        helper="Who created this character."
                        value={fields.creator || ''}
                        onChange={(v) => handleFieldChange('creator', v)}
                        multiline={false}
                      />
                      <Field
                        label="Creator Notes"
                        helper="Notes from the creator about how to use the character."
                        value={fields.creator_notes || ''}
                        onChange={(v) => handleFieldChange('creator_notes', v)}
                        rows={4}
                      />
                      <div className={styles.fieldGroup}>
                        <span className={styles.fieldLabel}>Tags</span>
                        <span className={styles.fieldHelper}>Categories and labels for organization.</span>
                        <div className={styles.tagsList}>
                          {tags.map((tag) => (
                            <span key={tag} className={styles.tag}>
                              {tag}
                              <button
                                type="button"
                                className={styles.tagRemove}
                                onClick={() => handleRemoveTag(tag)}
                              >
                                <X size={10} />
                              </button>
                            </span>
                          ))}
                          <div className={styles.tagAdd}>
                            <input
                              type="text"
                              className={styles.tagInput}
                              value={newTag}
                              onChange={(e) => setNewTag(e.target.value)}
                              onKeyDown={(e) => e.key === 'Enter' && handleAddTag()}
                              placeholder="Add tag..."
                            />
                            <button
                              type="button"
                              className={styles.tagAddBtn}
                              onClick={handleAddTag}
                              disabled={!newTag.trim()}
                            >
                              <Plus size={12} />
                            </button>
                          </div>
                        </div>
                      </div>
                    </>
                  )}

                  {activeTab === 'gallery' && (
                    <div className={styles.galleryTab}>
                      <div className={styles.galleryHeader}>
                        <span className={styles.fieldLabel}>Image Gallery</span>
                        <span className={styles.fieldHelper}>
                          Upload images for this character. These are personal to your account.
                        </span>
                      </div>

                      <div className={styles.galleryGrid}>
                        {galleryItems.map((item) => (
                          <div key={item.id} className={styles.galleryItem}>
                            <LazyImage
                              src={characterGalleryApi.thumbnailUrl(item.image_id)}
                              alt={item.caption || 'Gallery image'}
                              className={styles.galleryThumb}
                              fallback={<div className={styles.galleryThumbPlaceholder} />}
                            />
                            <button
                              type="button"
                              className={styles.galleryRemoveBtn}
                              onClick={() => handleGalleryRemove(item.id)}
                              title="Remove from gallery"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ))}

                        <button
                          type="button"
                          className={styles.galleryAddBtn}
                          onClick={() => galleryFileRef.current?.click()}
                          disabled={galleryUploading}
                        >
                          <ImagePlus size={20} />
                          <span>{galleryUploading ? 'Uploading...' : 'Add Image'}</span>
                        </button>
                      </div>

                      <input
                        ref={galleryFileRef}
                        type="file"
                        accept="image/*"
                        className={styles.hiddenInput}
                        onChange={handleGalleryUpload}
                      />

                      {embeddedImageCount > 0 && (
                        <div className={styles.galleryExtract}>
                          <Download size={14} />
                          <div className={styles.galleryExtractInfo}>
                            <span className={styles.fieldLabel}>Embedded Images</span>
                            <span className={styles.fieldHelper}>
                              {embeddedImageCount} image{embeddedImageCount !== 1 ? 's' : ''} found in character data
                            </span>
                          </div>
                          <button
                            type="button"
                            className={styles.addBtn}
                            disabled={extracting}
                            onClick={handleGalleryExtract}
                          >
                            {extracting ? 'Importing...' : 'Import All'}
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {activeTab === 'expressions' && character && (
                    <ExpressionEditorTab characterId={character.id} />
                  )}

                  {activeTab === 'advanced' && (
                    <>
                      <div className={styles.fieldGroup}>
                        <span className={styles.fieldLabel}>Attached World Book</span>
                        <span className={styles.fieldHelper}>Used by prompt assembly for world info activation.</span>
                        <select
                          className={styles.fieldInput}
                          value={(character.extensions?.world_book_id as string) || ''}
                          onChange={(e) => handleAttachedWorldBookChange(e.target.value)}
                        >
                          <option value="">No world book</option>
                          {worldBooks.map((wb) => (
                            <option key={wb.id} value={wb.id}>
                              {wb.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      {character.extensions?.character_book?.entries?.length > 0 && (
                        <div className={styles.lorebookImportSection}>
                          <BookOpen size={14} />
                          <div className={styles.lorebookImportInfo}>
                            <span className={styles.fieldLabel}>Embedded Lorebook</span>
                            <span className={styles.fieldHelper}>
                              {character.extensions.character_book.entries.length} entries found in character card
                            </span>
                          </div>
                          {lorebookResult ? (
                            <span className={styles.lorebookSuccess}>{lorebookResult}</span>
                          ) : (
                            <button
                              type="button"
                              className={styles.addBtn}
                              disabled={lorebookImporting}
                              onClick={async () => {
                                if (!editingCharacterId) return
                                setLorebookImporting(true)
                                try {
                                  const res = await worldBooksApi.importCharacterBook(editingCharacterId)
                                  const nextExtensions = {
                                    ...(character.extensions || {}),
                                    world_book_id: res.world_book.id,
                                  }
                                  await browser.updateCharacter(editingCharacterId, { extensions: nextExtensions })
                                  setExtensionsJson(JSON.stringify(nextExtensions, null, 2))
                                  setLorebookResult(`Imported ${res.entry_count} entries into "${res.world_book.name}" and attached it`)
                                } catch {
                                  setLorebookImporting(false)
                                }
                              }}
                            >
                              {lorebookImporting ? 'Importing...' : 'Import Lorebook'}
                            </button>
                          )}
                        </div>
                      )}
                      <div className={styles.fieldGroup}>
                        <span className={styles.fieldLabel}>Extensions (JSON)</span>
                        <span className={styles.fieldHelper}>
                          Raw JSON data for character extensions and custom fields.
                        </span>
                        <textarea
                          className={styles.jsonTextarea}
                          value={extensionsJson}
                          onChange={(e) => handleExtensionsChange(e.target.value)}
                          spellCheck={false}
                        />
                        {jsonError && <span className={styles.jsonError}>{jsonError}</span>}
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>

    <ImageCropModal {...cropModalProps} />

    {showDeleteConfirm && (
      <ConfirmationModal
        isOpen={true}
        title="Delete Character"
        message={`Delete "${character?.name || 'this character'}" permanently? This cannot be undone.`}
        variant="danger"
        confirmText="Delete"
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    )}
    </>,
    document.body
  )
}

function Field({
  label,
  helper,
  value,
  onChange,
  rows = 4,
  multiline = true,
}: {
  label: string
  helper: string
  value: string
  onChange: (v: string) => void
  rows?: number
  multiline?: boolean
}) {
  return (
    <div className={styles.fieldGroup}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.fieldHelper}>{helper}</span>
      {multiline ? (
        <ExpandableTextarea
          className={styles.fieldTextarea}
          value={value}
          onChange={onChange}
          rows={rows}
          title={label}
          placeholder={`${label}...`}
        />
      ) : (
        <input
          type="text"
          className={styles.fieldInput}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`${label}...`}
        />
      )}
    </div>
  )
}
